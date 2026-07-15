# Sprint Briefing: Implement bober-security-auditor agent, runSecurityAudit core, and stack knowledge injection

**Contract:** sprint-spec-20260712-security-audit-agent-team-2
**Generated:** 2026-07-12T00:00:00Z

> **THE DOMINANT RULE OF THIS SPRINT (sc-2-2):** the code-reviewer's parse fallback
> at `src/orchestrator/code-reviewer-agent.ts:325-337` returns an EMPTY review on parse
> failure — a silent `verdict:'pass'`. The security core MUST INVERT this: parse failure
> yields `parsed:false` and `verdict:'blocked'`. Do NOT reuse `parseReviewResult`.

---

## 1. Target Files

All five files are **create** (verified: `grep` finds no existing importer of
`security-auditor-agent` or `stack-knowledge`). No `modify` targets → no existing
call sites to break. Sprint 1 already shipped the types/store/config this consumes.

### `src/orchestrator/security-auditor-agent.ts` (create)

**Most similar existing file:** `src/orchestrator/code-reviewer-agent.ts` — mirror its
structure EXACTLY (deps via top-level imports so tests can `vi.mock` them; prompt build →
`runAgenticLoop` → parse → persist). Its `runCodeReviewer` is at `code-reviewer-agent.ts:54-175`.

**Exports required:** `runSecurityAudit(...)` and `parseSecurityAuditResult(text, contractId, specId) => { review: ReviewResult; parsed: boolean }`.

**Signature (from ADR + generatorNotes — accept `priors` now to avoid sprint-5 churn):**
```typescript
import type { BoberConfig } from "../config/schema.js";
import type { SprintContract } from "../contracts/sprint-contract.js";
import type { EvaluationRunResult } from "../evaluators/registry.js";
import type { ReviewResult } from "./code-reviewer-agent.js";               // LOCKED shape, type-only
import type { SecurityAuditResult, SecurityFinding } from "./security-audit-types.js";
import { deriveVerdict } from "./security-audit-types.js";
import { createClient } from "../providers/factory.js";
import { resolveModel } from "./model-resolver.js";
import { assembleSystemPrompt } from "./agent-loader.js";
import { resolveRoleTools, getGraphState, getGraphDeps } from "./tools/index.js";
import { runAgenticLoop } from "./agentic-loop.js";
import { budgetFromMaxUsd } from "./workflow/budget.js";
import { saveSecurityAudit } from "../state/security-audit-state.js";        // NOT the barrel (sprint 1 note)
import { resolveStackSecurityContext } from "./stack-knowledge.js";
import { logger } from "../utils/logger.js";

export async function runSecurityAudit(
  contract: SprintContract,
  evaluation: EvaluationRunResult | null,   // null => standalone mode, omit eval-context section
  projectRoot: string,
  config: BoberConfig,
  priors: SecurityFinding[] = [],           // sprint-5 seam; when non-empty render a priors section
): Promise<SecurityAuditResult> { /* ... */ }
```

**Config field reads (sc-2-6 — all under `config.security`, which is `.optional()`):**
- `config.security?.model` → `resolveModel(...)` (default handled by schema when section present)
- `config.security?.provider`, `config.security?.endpoint`, `config.security?.providerConfig` → `createClient(...)`
- `config.security?.maxTurns`
- `config.security?.budget?.maxUsd` → `budgetFromMaxUsd(...)`

**Verdict wiring (THE inversion — sc-2-2):**
```typescript
const { review, parsed } = parseSecurityAuditResult(result.finalText, contractId, contract.specId);
const verdict: "pass" | "blocked" = parsed ? deriveVerdict(review) : "blocked";
const auditResult: SecurityAuditResult = { review, stack: ctx.stackLabel, scannerRan: priors.length > 0, parsed, verdict };
await saveSecurityAudit(projectRoot, contractId, auditResult);
return auditResult;
```

**Test file:** `src/orchestrator/security-auditor-agent.test.ts` — does not exist (create).

---

### `src/orchestrator/stack-knowledge.ts` (create)

**Export:** `resolveStackSecurityContext(stack)` returning
`{ stackLabel, skillName, taxonomy, promptFragment }` (shape = `StackSecurityContext` in the arch doc, lines 185-191).

**Reads:** the matching skill's security section (bounded excerpt, NOT the whole ~400-line file),
`fs`-error → generic fallback, **never throws** (API contract, arch line 261).
**Generic taxonomy fragment source:** call `resolveLensFocus("security")` from
`src/orchestrator/eval-lenses.ts:24` (the `security` fragment text lives at `eval-lenses.ts:7-8`;
it is NOT exported directly — go through the resolver).

**Test file:** `src/orchestrator/stack-knowledge.test.ts` — does not exist (create).

---

### `agents/bober-security-auditor.md` (create)

**Directory pattern:** every agent is one `agents/<name>.md` file (13 exist; e.g. `agents/bober-code-reviewer.md`).
**Template:** copy the frontmatter + body structure of `agents/bober-code-reviewer.md:1-53`.
**Frontmatter (read-only tools ONLY — sc-2-4, nonGoal "no write/edit/bash-write"):**
```yaml
---
name: bober-security-auditor
description: <one line — stack-aware security auditor; emits ReviewResult findings; never writes files>
tools:
  - Read
  - Bash
  - Grep
  - Glob
model: opus
---
```
> The tool NAMES in frontmatter are Read/Bash/Grep/Glob (matching `bober-code-reviewer.md:4-8`).
> The actual runtime tool set comes from the `"evaluator"` role (see §2). "Read-only" here means
> no Write/Edit — Bash is included exactly as the code-reviewer has it.

**Body MUST specify the output JSON contract that `parseSecurityAuditResult` actually reads**
(cross-check field names — a drifted name is a real bug per evaluatorNotes): the locked
`ReviewResult` shape (`reviewId, contractId, specId, timestamp, summary, critical[], important[],
minor[], approvedAreas[]`) with each finding = `{ description, evidence:[{path,line,snippet}], vulnClass? }`.
Define severity buckets: **critical** = exploitable vulnerability endangering funds/data (→ blocks);
**important** = weakness needing attention (non-blocking). Instruct: never write/edit files; emit ONLY JSON.

---

## 2. Patterns to Follow

### Pattern A — Role/tools/prompt wiring (copy verbatim, swap the agent name)
**Source:** `src/orchestrator/code-reviewer-agent.ts:69-80`
```typescript
const graphState = getGraphState(config);
const graphDeps = graphState.engineHealth === "ready" ? getGraphDeps() : undefined;
const toolSet = resolveRoleTools("evaluator", projectRoot, graphState, graphDeps ?? undefined);
const systemPrompt = await assembleSystemPrompt("evaluator", "bober-security-auditor", projectRoot, graphState);
const client = createClient(
  config.security?.provider ?? null,
  config.security?.endpoint ?? null,
  config.security?.providerConfig,
  config.security?.model,
  "SecurityAuditor",
);
```
**Rule:** Reuse the `"evaluator"` AgentRole — it grants read-only tools `["bash","read_file","glob","grep"]`
(`src/orchestrator/tools/index.ts:67`). It is a valid `AgentRole` (`tools/index.ts:23-31`) AND a valid
`BoberAgentRole` (used by `assembleSystemPrompt`). Do NOT invent a new role (nonGoal / matches ADR-1 "by role, not stack").

### Pattern B — Invoke the loop (mirror the reviewer, add budget)
**Source:** `src/orchestrator/code-reviewer-agent.ts:144-158` + budget from `src/orchestrator/generator-agent.ts:58,131`
```typescript
const budget = budgetFromMaxUsd(config.security?.budget?.maxUsd);        // budget.ts:148 — undefined when maxUsd null/absent
const result = await runAgenticLoop({
  client, model, systemPrompt, userMessage,
  tools: toolSet.schemas,
  toolHandlers: toolSet.handlers,
  maxTurns,
  maxTokens: 16384,
  ...(budget !== undefined ? { budget } : {}),                            // spread-guard keeps byte-identical when absent
  onToolUse: (name, input) => { /* logger.debug */ },
});
```
**Rule:** `runAgenticLoop` (`src/orchestrator/agentic-loop.ts:382`) returns
`{ finalText, turnsUsed, toolsCalled, usage, stopReason, ... }` — it does NOT throw on provider error;
it returns `stopReason:"error"`. See Pitfalls for how sc-2-5 (client throw → reject) is satisfied.

### Pattern C — Resilient JSON extraction, THEN fail-closed (the ONE thing that differs)
**Source of the extraction ladder to REUSE:** `src/orchestrator/code-reviewer-agent.ts:273-299`
(direct `JSON.parse` → markdown-fence regex → first-`{`-to-last-`}` slice).
**Source of the fallback to INVERT (do NOT copy this):** `code-reviewer-agent.ts:325-337`.
```typescript
// parseSecurityAuditResult: run the SAME extraction ladder (:273-299).
// On success + object shape → build ReviewResult, return { review, parsed: true }.
// On ANY failure (all three parse attempts fail, or not an object) → return
//   { review: <empty ReviewResult with summary "Security auditor output could not be parsed.">, parsed: false }.
// The caller sets verdict = parsed ? deriveVerdict(review) : "blocked".
```
**Rule:** `parsed:false` is the fail-closed signal. A genuinely-clean audit is `parsed:true` +
empty `critical` + `verdict:"pass"`. These MUST be distinguishable (sc-2-2). Field parsers
`parseFindingArray`/`parseEvidenceArray` (`code-reviewer-agent.ts:339-369`) can be re-implemented
locally, adding the optional `vulnClass` passthrough for `SecurityFinding`.

### Pattern D — Prompt with a null-able section (standalone mode, sc-2-5)
**Source of the prompt-assembly style:** `code-reviewer-agent.ts:82-140` (template string with `# Section` headers).
**Rule:** When `evaluation === null`, OMIT the evaluation-context section entirely. When `priors.length > 0`,
add a `# Deterministic scanner findings (ground truth priors)` section. The resolved `ctx.promptFragment`
MUST appear verbatim in the user message (sc-2-3 asserts it by capturing the mocked loop's `userMessage`).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `deriveVerdict` | `src/orchestrator/security-audit-types.ts:52` | `(review: ReviewResult) => "pass" \| "blocked"` | Pure: blocked iff `critical.length > 0`. Call ONLY when `parsed:true`. |
| `SecurityAuditResult` / `SecurityFinding` / `VulnClass` | `src/orchestrator/security-audit-types.ts:9,23,32` | types | Sprint-1 wrapper types over locked `ReviewResult`. Import; never redefine. |
| `saveSecurityAudit` | `src/state/security-audit-state.ts:29` | `(projectRoot, contractId, result) => Promise<void>` | Persists to `.bober/security/<id>-security-audit.md`. Import from the module path, NOT `src/state/index.js`. |
| `createClient` | `src/providers/factory.ts:192` | `(provider?, endpoint?, providerConfig?, model?, role?) => LLMClient` | The ONLY provider entry point (sc-2-6: no SDK imports outside `src/providers/`). |
| `runAgenticLoop` | `src/orchestrator/agentic-loop.ts:382` | `(AgenticLoopParams) => Promise<AgenticLoopResult>` | Read-only agentic loop driver. |
| `resolveModel` | `src/orchestrator/model-resolver.ts:106` | `(choice: string) => string` | Shorthand ("opus") → concrete model id. |
| `assembleSystemPrompt` | `src/orchestrator/agent-loader.ts:193` | `(role, agentName, projectRoot, ctx) => Promise<string>` | Loads `agents/<agentName>.md` + graph/env decoration. |
| `resolveRoleTools` | `src/orchestrator/tools/index.ts:176` | `(role, projectRoot, ctx?, graphDeps?) => ToolSet` | Role → `{schemas, handlers}`. Use role `"evaluator"`. |
| `getGraphState` / `getGraphDeps` | `src/orchestrator/tools/index.ts:130,148` | `(config?) => GraphState` / `() => deps\|null` | Graph gating context. |
| `budgetFromMaxUsd` | `src/orchestrator/workflow/budget.ts:148` | `(maxUsd: number\|null\|undefined) => Budget \| undefined` | `undefined` when uncapped → clean spread-guard. |
| `resolveLensFocus` | `src/orchestrator/eval-lenses.ts:24` | `(lens: string) => string` | `resolveLensFocus("security")` → the canonical security taxonomy fragment (sc-2-3). |
| `renderReviewMarkdown` | `src/orchestrator/code-reviewer-agent.ts:183` | `(review: ReviewResult) => string` | Already used by the store — you do NOT call it directly (store does). |

Directories reviewed for reuse: `src/orchestrator/`, `src/orchestrator/tools/`, `src/orchestrator/workflow/`,
`src/state/`, `src/providers/`, `src/config/`. No generic `utils/`/`helpers/` symbol is needed beyond `logger`
(`src/utils/logger.js`).

---

## 4. Prior Sprint Output

### Sprint 1 (commits f76ee2e / fc20eae / 4ae188f)
**Created `src/orchestrator/security-audit-types.ts`** — exports `VulnClass` (`:9-15`),
`SecurityFinding` (`:23-25`, extends `ReviewFinding` with optional `vulnClass`),
`SecurityAuditResult` (`:32-43`), `deriveVerdict` (`:52-54`). **Import these; do not redefine.**

**Created `src/state/security-audit-state.ts`** — exports `saveSecurityAudit` (`:29`),
`readSecurityAudit` (`:45`), `listSecurityAudits` (`:62`) over `.bober/security/`, rendering via
`renderReviewMarkdown(result.review)`. **NOT in `src/state/index.ts` barrel** → import from the file path.

**Extended `src/config/schema.ts`** — `SecuritySectionSchema` (`:210-229`) wired as
`security: SecuritySectionSchema.optional()` on `BoberConfigSchema` (`:633`). Fields you consume:
`enabled, failClosed, timeoutMs, model(default "opus"), maxTurns(default 20), provider?, endpoint?,
providerConfig?, budget?, scanners(default []), standaloneBlockOn, hub`.

**Connection:** this sprint wires the callable core between the sprint-1 types/store/config and the
sprint-3 gate / sprint-4 CLI (which are OUT OF SCOPE — export only).

---

## 5. Relevant Documentation

### Project Principles — `.bober/principles.md` (exists)
Headings: Mission, Users, Quality Standards, Technical Principles (Follow/Avoid), Design Principles.
Directly relevant: **fail-closed on safety** (mirrors medical `consent.ts`/`guardrails.ts`), evidence-cited
findings (path+line+snippet), additive/opt-in/byte-identical-when-unconfigured.

### Architecture — `.bober/architecture/arch-20260712-security-audit-agent-team-architecture.md` (exists)
- **Risk table (line 346):** unparseable output → `parseReviewResult` benign fallback → false 'pass' is
  the CRITICAL risk; mitigation = `parsed:boolean` + gate treats `parsed===false` as audit-error. This
  sprint owns the `parsed` half.
- **API Contracts (line 259):** `runSecurityAudit` — provider/network/budget error → **throws**;
  unparseable output → result with `parsed:false` (does NOT throw). Two different failure modes.
- **StackKnowledgeInjector (lines 176-192, 261):** unknown/absent stack → `{skillName:null, generic taxonomy}`; never throws.
- ADRs 1-6 are linked stubs; the binding constraints are inlined in the sections above.

---

## 6. Testing Patterns

**Runner:** Vitest. **Assertion:** `expect`. **Mocks:** `vi.mock` (module) + `vi.fn` (spies).
**File naming:** `<module>.test.ts`, **co-located** next to the module.

### Unit Test Pattern — fake the loop + client, capture the prompt
**Source:** `src/orchestrator/evaluator-agent.test.ts:20-97` (THE pattern to copy — it mocks
`runAgenticLoop`, `createClient`, `resolveModel`, `assembleSystemPrompt`, and `tools/index`).
```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const loopSpy = vi.fn(async () => ({
  finalText: JSON.stringify({ reviewId:"r", contractId:"c", specId:"s", timestamp:"t",
    summary:"one critical", critical:[{ description:"reentrancy", evidence:[{path:"C.sol",line:12,snippet:"call{value:x}()"}], vulnClass:"privilege-escalation" }],
    important:[], minor:[], approvedAreas:[] }),
  turnsUsed: 1, toolsCalled: [], usage:{ inputTokens:0, outputTokens:0 }, stopReason:"end_turn" as const,
}));
const clientSpy = vi.fn(() => ({} as never));

vi.mock("./agentic-loop.js", () => ({ runAgenticLoop: loopSpy }));
vi.mock("../providers/factory.js", () => ({ createClient: clientSpy }));
vi.mock("./model-resolver.js", () => ({ resolveModel: () => "model-test" }));
vi.mock("./agent-loader.js", () => ({ assembleSystemPrompt: vi.fn().mockResolvedValue("SYS") }));
vi.mock("./tools/index.js", () => ({
  resolveRoleTools: () => ({ schemas: [], handlers: new Map() }),
  getGraphState: () => ({ enabled: false, engineHealth: "disabled" }),
  getGraphDeps: () => undefined,
}));
// keep saveSecurityAudit real against a mkdtemp root, OR vi.mock("../state/security-audit-state.js").
```
**Assertions to write (map to criteria):**
- **sc-2-1:** well-formed critical → `result.review.critical.length===1`, `parsed===true`, `verdict==='blocked'`, `result.stack` set, and `saveSecurityAudit` invoked.
- **sc-2-2 (DOMINANT — two malformed cases):** `loopSpy.mockResolvedValueOnce({ finalText: "sorry, I cannot help", ... })` → `parsed===false`, `verdict!=='pass'` (expect `'blocked'`); AND a truncated-JSON case `finalText: '{"critical":[{"desc'` → `parsed===false`. Then a clean case (`critical:[]`) → `parsed===true`, `verdict==='pass'` — assert the two are distinguishable.
- **sc-2-3:** capture `loopSpy.mock.calls[0][0].userMessage` and assert it `.toContain(ctx.promptFragment)`.
- **sc-2-5 (client throw → reject):** `loopSpy.mockRejectedValueOnce(new Error("provider down"))` then `await expect(runSecurityAudit(...)).rejects.toThrow()`. Also assert `evaluation:null` omits the eval section from the captured prompt.

### Temp-dir pattern (for stack-knowledge missing-skill fallback, sc-2-3)
**Source:** `src/state/security-audit-state.test.ts:1-20` — `mkdtemp(join(tmpdir(),"..."))` in `beforeEach`,
`rm(..,{recursive,force})` in `afterEach`. Use a fake skills root (pass a base dir into
`resolveStackSecurityContext`, or write a temp `SKILL.md`) to prove: file present → checklist in
`promptFragment`; file absent → generic taxonomy, `skillName:null`, no throw.

### Type-shape test reference
**Source:** `src/orchestrator/security-audit-types.test.ts:1-95` — style for asserting result shapes / `it.each` verdict tables.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| (none) | new `security-auditor-agent.ts` / `stack-knowledge.ts` | low | Both are **create** targets — `grep` confirms zero existing importers. Sprints 3/4 will consume them. |
| `src/orchestrator/code-reviewer-agent.ts` | you import `ReviewResult` (type-only) | low | Do NOT modify it (nonGoal). Type-only import cannot break it. |
| `src/orchestrator/security-audit-types.ts` | you import `deriveVerdict` + types | low | Sprint-1 file; import only, no edits. |

### Existing Tests That Must Still Pass (run the FULL suite — sc-2-7)
- `src/orchestrator/security-audit-types.test.ts` — sprint-1 types/`deriveVerdict`; you reuse them, must stay green.
- `src/state/security-audit-state.test.ts` — sprint-1 store round-trip; `saveSecurityAudit` unchanged.
- `src/orchestrator/code-reviewer-agent.test.ts` — you neither edit nor re-export its module.
- `src/config/loader.test.ts` / schema tests — `config.security` optional; no schema change this sprint.

### Features That Could Be Affected
- **Advisory code-review (`runCodeReviewer`)** — shares the `ReviewResult` shape and `renderReviewMarkdown`.
  Verify you do NOT alter `code-reviewer-agent.ts`; the security path is entirely new code (nonGoal).

### Recommended Regression Checks (concrete, runnable)
1. `npm run build` — passes.
2. `npm run typecheck` — passes (strict; ESM `.js` import extensions required).
3. `npm run lint` (or the ESLint script) — zero errors.
4. `npx vitest run src/orchestrator/security-auditor-agent.test.ts src/orchestrator/stack-knowledge.test.ts` — new tests green.
5. `npx vitest run` — full suite green (zero regressions).
6. `grep -rn "@anthropic-ai/sdk\|from \"openai\"" src --include="*.ts" | grep -v "src/providers/"` — no NEW provider SDK import in your files (sc-2-6).

---

## 8. Implementation Sequence (dependency-ordered)

1. **`src/orchestrator/stack-knowledge.ts`** — `resolveStackSecurityContext(stack)`. No deps except
   `eval-lenses.resolveLensFocus` + `security-audit-types.VulnClass` + `fs`. Map stack→skill (see Pitfalls),
   read bounded security excerpt, generic fallback, never throw.
   - Verify: unit-test present-skill vs missing-skill (temp dir); `skillName:null` on unknown.
2. **`agents/bober-security-auditor.md`** — no code deps. Field names in its JSON contract MUST match
   what `parseSecurityAuditResult` reads (write step 3 first if unsure, then reconcile).
   - Verify: frontmatter tools = Read/Bash/Grep/Glob (no Write/Edit); body forbids writing; output = ReviewResult shape.
3. **`src/orchestrator/security-auditor-agent.ts`** — `parseSecurityAuditResult` (fail-closed) + `runSecurityAudit`.
   Depends on step 1 + sprint-1 types/store/config + loop/client/tools helpers.
   - Verify: `verdict = parsed ? deriveVerdict(review) : "blocked"`; `evaluation:null` omits eval section; `priors` default `[]`.
4. **`src/orchestrator/stack-knowledge.test.ts`** — cover sc-2-3 resolver mapping + fallback.
5. **`src/orchestrator/security-auditor-agent.test.ts`** — cover sc-2-1/2/3/5/6 with the mocked-loop pattern.
6. **Run full verification** — `npm run build`, `npm run typecheck`, ESLint, `npx vitest run`.

---

## 9. Pitfalls & Warnings

- **DO NOT reuse `parseReviewResult`'s fallback** (`code-reviewer-agent.ts:325-337`). It returns empty
  `critical` on parse failure → a silent pass. Your fallback must set `parsed:false`, and the caller must
  force `verdict:"blocked"` when `!parsed`. This is sc-2-2, the dominant, test-demonstrated criterion.
- **Stack input shape is genuinely ambiguous — resolve it deliberately.** `config.project.stack` is
  `StackSchema` = an OBJECT (`schema.ts:8-17`: `{ frontend?, backend?, blockchain?, testing?, database?,
  language?, other?[] }`), but sc-2-3 phrases the mapping as `solidity→bober.solidity`, `anchor→bober.anchor`,
  `react→bober.react`. Recommended: scan the stack's string field values (lower-cased) for the substrings
  `solidity`/`anchor`/`react` (blockchain/language for solidity/anchor, frontend for react), with a
  documented precedence; also accept `stack` possibly being a plain string for test ergonomics. Return
  `{skillName:null, taxonomy: generic, promptFragment: resolveLensFocus("security")}` for unknown/absent.
- **Only `bober.solidity` has a clean `## Security Checklist` heading** (`skills/bober.solidity/SKILL.md:399-412`).
  `bober.anchor`'s security content is under "Anchor-Specific Evaluation Enhancements"
  (`skills/bober.anchor/SKILL.md:262-307`, no dedicated heading); `bober.react/SKILL.md` has NO security
  section. Make excerpt extraction tolerant (find a security-ish heading; else bounded head excerpt; else
  generic) and ALWAYS append `resolveLensFocus("security")` as the taxonomy backbone. Never read the whole file into the prompt.
- **The security lens fragment is NOT a direct export.** `eval-lenses.ts` only exports `resolveLensFocus`
  (`:24`); the `security` text is a private catalog entry (`:7-8`). Call `resolveLensFocus("security")`.
- **`runAgenticLoop` does not throw on provider error** — it returns `stopReason:"error"`
  (`agentic-loop.ts:556-583`). sc-2-5 requires a client throw to REJECT: do NOT wrap the `runAgenticLoop`
  call in a try/catch that swallows — let a rejection propagate. (The test drives this by
  `loopSpy.mockRejectedValueOnce(...)`.) Optionally also treat `stopReason==="error"|"budget_exceeded"` as a
  throw for real fail-closed behavior, but the required test is the reject-propagation one.
- **Import `saveSecurityAudit` from `../state/security-audit-state.js`, not `../state/index.js`** — sprint 1
  deliberately left it out of the barrel.
- **ESM discipline:** all relative imports need the `.js` extension (this is `NodeNext`/strict ESM). Type-only
  imports use `import type`.
- **`config.security` is optional** — when a test passes a config with the section present, the Zod defaults
  (`model:"opus"`, `maxTurns:20`) apply. Do not hard-code model/maxTurns; read from `config.security`.
- **No new provider SDK import** anywhere in your files (sc-2-6) — everything goes through `createClient`.
- **Do not touch pipeline.ts, the CLI, scanner execution, or hub emission** (nonGoals / sprints 3-6). Export a
  callable core only; the `priors` parameter is the documented sprint-5 seam.
