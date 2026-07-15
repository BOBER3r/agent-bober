# Sprint Briefing: Adversarial finder→verifier stage (fresh, contract-free, downgrade-only, fail-closed)

**Contract:** sprint-spec-20260714-security-auditor-per-stack-skills-8
**Generated:** 2026-07-14T00:00:00Z
**Keystone sprint:** this is the false-positive control. Every `critical` finding hard-blocks the sprint (`security-gate.ts:137-139`), so a fail-open verifier would be a regression. Read the invariants in section 9 FIRST.

---

## 0. What you are building (mental model)

A SECOND read-only LLM stage that runs *sequentially* after the existing finder, INSIDE `runSecurityAudit`, and BEFORE `deriveVerdict`. It is fed ONLY the finder's `critical + important` findings (never the sprint contract — that strips the sycophancy framing), is told to DISPROVE each finding, and may ONLY downgrade (`critical→important`) or drop a finding — NEVER promote or manufacture a clean pass. Any parse failure / provider error / abort ⇒ `ran:false` ⇒ the finder's criticals are KEPT unchanged. The verdict is then derived on the VERIFIED (folded) review via the UNCHANGED `deriveVerdict`.

Three new files + three touched files (per `estimatedFiles`):
- CREATE `agents/bober-security-verifier.md` — the refutation prompt (mirror the auditor agent).
- CREATE `src/orchestrator/security-verifier-agent.ts` — `runSecurityVerifier.verify(...)` + `VerifierResult` + the fold helper.
- CREATE `src/orchestrator/security-verifier-agent.test.ts` — verifier unit tests.
- MODIFY `src/config/schema.ts` — add `security.verifier` optional object.
- MODIFY `src/config/schema.test.ts` — verifier schema tests (keep the two deep-equal tripwires green).
- MODIFY `src/orchestrator/security-auditor-agent.ts` — add `deps.verifier`, fold the stage in after the finder parse.
- MODIFY `src/orchestrator/security-auditor-agent.test.ts` — sc-8 fold/fail-closed/byte-identical tests.

---

## 1. Target Files

### src/orchestrator/security-auditor-agent.ts (modify)

**A. `SecurityAuditDeps` — add `verifier?` here (lines 28-30):**
```ts
export interface SecurityAuditDeps {
  diffProvider?: SecurityDiffProvider;
}
```
Add `verifier?: SecurityVerifier;` (import the interface from `./security-verifier-agent.js`). Appended so all existing positional callers stay byte-compatible, exactly like `diffProvider` was (comment at lines 24-30 explains the pattern).

**B. `runSecurityAudit` signature (lines 77-84) — the `deps` param is already the last positional:**
```ts
export async function runSecurityAudit(
  contract: SprintContract,
  evaluation: EvaluationRunResult | null,
  projectRoot: string,
  config: BoberConfig,
  priors: SecurityFinding[] = [],
  deps: SecurityAuditDeps = {},
): Promise<SecurityAuditResult> {
```

**C. Finder model/client/tools resolution (lines 88-107) — the verifier MIRRORS this but read-only + different agent name + its own model/maxTurns:**
```ts
  const securityModel = config.security?.model ?? "opus";
  const model = resolveModel(securityModel);
  const maxTurns = config.security?.maxTurns ?? 20;
  ...
  const graphState = getGraphState(config);
  const graphDeps = graphState.engineHealth === "ready" ? getGraphDeps() : undefined;
  const toolSet = resolveRoleTools("curator", projectRoot, graphState, graphDeps ?? undefined);
  const systemPrompt = await assembleSystemPrompt("curator", "bober-security-auditor", projectRoot, graphState);
  const client = createClient(
    config.security?.provider ?? null,
    config.security?.endpoint ?? null,
    config.security?.providerConfig,
    securityModel,
    "SecurityAuditor",
  );
```

**D. The finder `runAgenticLoop` call (lines 227-242) — NOTE: it currently has NO `abortSignal`. DO NOT add one (see pitfalls):**
```ts
  const budget = budgetFromMaxUsd(config.security?.budget?.maxUsd);
  const result = await runAgenticLoop({
    client, model, systemPrompt, userMessage,
    tools: toolSet.schemas, toolHandlers: toolSet.handlers,
    maxTurns, maxTokens: 16384,
    ...(budget !== undefined ? { budget } : {}),
    onToolUse: (name, input) => { /* logging */ },
  });
```

**E. THE FOLD POINT — finder parse (line 248) and verdict (line 253). Insert the verifier stage BETWEEN them:**
```ts
  const { review, parsed } = parseSecurityAuditResult(result.finalText, contractId, contract.specId);

  // THE inversion (sc-2-2): verdict is only ever derived from a genuinely
  // parsed review. A parse failure forces 'blocked' ...
  const verdict: "pass" | "blocked" = parsed ? deriveVerdict(review) : "blocked";
```
`review` is destructured `const` — you must rename it (e.g. `const { review: finderReview, parsed } = ...`) and hold a mutable `let review = finderReview;` so the fold can replace it. The verifier ONLY runs when `parsed === true && config.security?.verifier?.enabled === true`. When it doesn't run, `review` stays `finderReview` and the line-253 verdict is byte-identical. See section 8 for the exact insertion.

**F. `auditResult` construction (lines 255-266) — uses the (now folded) `review` and `verdict`; `deriveVerdict` and this block stay structurally unchanged:**
```ts
  const auditResult: SecurityAuditResult = {
    review, stack: ctx.stackLabel,
    scannerRan: configuredScanners.length > 0 || effectivePriors.length > 0,
    parsed, verdict,
  };
  await saveSecurityAudit(projectRoot, contractId, auditResult);
```

**G. The AbortController+timeout seam pattern the verifier stage MUST copy (from the supply-chain seam, lines 186-209 — identical shape at 121-122 and 159-163):**
```ts
  const scAbort = new AbortController();
  const scTimer = setTimeout(() => scAbort.abort(), config.security?.timeoutMs ?? 300_000);
  try {
    // ... await the stage using scAbort.signal ...
  } finally {
    clearTimeout(scTimer);
  }
```

**H. `buildUserMessage` — THE SYCOPHANCY SURFACE the verifier must EXCLUDE (lines 306-398).** The finder message folds in the FULL contract JSON + evaluation "Already Passed" framing + priors + diff. The verifier user message must contain NONE of the contract/eval parts:
```ts
  const contractJson = JSON.stringify(contract, null, 2);      // line 317 — EXCLUDE from verifier
  const evalSection = evaluation !== null
    ? `# Evaluation Result (Already Passed)\n\n${JSON.stringify({...})}\n\n` : "";  // 321-333 — EXCLUDE
  ...
  return `# Sprint Contract\n\n${contractJson}\n\n${evalSection}${priorsSection}${changedFilesSection}# Stack Security Context ...`;  // 353-397 — the "# Sprint Contract" heading + JSON is the framing to strip
```
The `# Changed files (real diff)` section (rendered by `renderChangedFilesSection`, lines 284-304) is the ONLY part the verifier SHOULD reuse — it carries the `path (status)` + hunk `content` evidence the verifier re-checks against.

**Imports this file uses (top of file, lines 1-21):** `deriveVerdict` (6), `createClient` (7), `resolveModel` (8), `assembleSystemPrompt` (9), `resolveRoleTools, getGraphState, getGraphDeps` (10), `runAgenticLoop` (11), `budgetFromMaxUsd` (12), types `AuditDiff, SecurityDiffProvider` (18), `SecurityFinding` (5). The verifier module imports the SAME set.

**Imported by:** `src/orchestrator/security-gate.ts:25` (`runSecurityAudit`), `src/cli/commands/security-audit.ts`, `src/orchestrator/security-hub.ts`. None import the verifier — the fold is internal to `runSecurityAudit`, so no caller changes.

**Test file:** `src/orchestrator/security-auditor-agent.test.ts` (exists — 821 lines).

---

### src/orchestrator/security-verifier-agent.ts (create)

**Directory pattern:** siblings in `src/orchestrator/` use kebab-case `*-agent.ts` (`security-auditor-agent.ts`, `code-reviewer-agent.ts`, `evaluator-agent.ts`). Named exports, `.js` extension on relative imports (ESM).
**Most similar existing file:** `src/orchestrator/security-auditor-agent.ts` — follow its import block, its `runAgenticLoop` call shape, and its fail-closed parse discipline.

**Structure template (skeleton — cite auditor lines for each borrowed piece):**
```ts
import type { BoberConfig } from "../config/schema.js";
import type { SecurityFinding } from "./security-audit-types.js";
import type { AuditDiff } from "./security-knowledge/diff-provider.js";
import { createClient } from "../providers/factory.js";
import { resolveModel } from "./model-resolver.js";
import { assembleSystemPrompt } from "./agent-loader.js";
import { resolveRoleTools, getGraphState, getGraphDeps } from "./tools/index.js";
import { runAgenticLoop } from "./agentic-loop.js";
import { budgetFromMaxUsd } from "./workflow/budget.js";
import { logger } from "../utils/logger.js";

/** Downgrade-only, fail-closed verifier result. `ran:false` => finder criticals kept. */
export interface VerifierResult {
  verified: SecurityFinding[];   // confirmed — stay at finder severity (criticals stay critical)
  downgraded: SecurityFinding[]; // critical->important
  dropped: SecurityFinding[];    // disproved — removed
  ran: boolean;                  // false on parse-fail / provider error / abort
}

export interface VerifyParams {
  findings: SecurityFinding[];   // finder critical + important ONLY (never approvedAreas/minor)
  diff: AuditDiff | undefined;   // the SAME AuditDiff the finder saw; hunks are the re-check evidence
  projectRoot: string;
  config: BoberConfig;
  signal: AbortSignal;           // shared time-box (keyed to config.security.timeoutMs by the caller)
}

/** Injectable seam so runSecurityAudit tests can stub the stage (mirrors SecurityDiffProvider). */
export interface SecurityVerifier {
  verify(params: VerifyParams): Promise<VerifierResult>;
}

export const runSecurityVerifier: SecurityVerifier = {
  async verify(params) {
    const { findings, diff, projectRoot, config, signal } = params;
    // Empty input => nothing to verify; ran:true with all buckets empty is a clean no-op.
    // Resolve model/client from config.security.verifier (default opus / maxTurns 10).
    const verifierModel = config.security?.verifier?.model ?? "opus";
    const model = resolveModel(verifierModel);
    const maxTurns = config.security?.verifier?.maxTurns ?? 10;
    const graphState = getGraphState(config);
    const graphDeps = graphState.engineHealth === "ready" ? getGraphDeps() : undefined;
    const toolSet = resolveRoleTools("curator", projectRoot, graphState, graphDeps ?? undefined);
    const systemPrompt = await assembleSystemPrompt("curator", "bober-security-verifier", projectRoot, graphState);
    const client = createClient(
      config.security?.provider ?? null,
      config.security?.endpoint ?? null,
      config.security?.providerConfig,
      verifierModel,
      "SecurityVerifier",
    );
    const budget = budgetFromMaxUsd(config.security?.budget?.maxUsd);
    const userMessage = buildVerifierUserMessage(findings, diff); // NO contract, NO eval

    let result;
    try {
      result = await runAgenticLoop({
        client, model, systemPrompt, userMessage,
        tools: toolSet.schemas, toolHandlers: toolSet.handlers,
        maxTurns, maxTokens: 16384,
        ...(budget !== undefined ? { budget } : {}),
        abortSignal: signal,   // <-- verifier DOES take the shared signal
      });
    } catch {
      return { verified: [], downgraded: [], dropped: [], ran: false }; // fail-closed
    }
    // Fail-closed on abort/error/refusal stop reasons.
    if (result.stopReason === "aborted" || result.stopReason === "error" || result.refused === true) {
      return { verified: [], downgraded: [], dropped: [], ran: false };
    }
    return parseVerifierResult(result.finalText, findings); // fail-closed: unparseable => ran:false
  },
};
```
Key sub-functions to add:
- `buildVerifierUserMessage(findings, diff)` — renders ONLY the findings (as JSON) + the diff hunks. Reuse the exact hunk-rendering shape from `renderChangedFilesSection` (auditor lines 284-304) so evidence matches. NO `# Sprint Contract`, NO `# Evaluation Result`.
- `parseVerifierResult(text, inputFindings): VerifierResult` — INVERT the auditor's fail-closed parser (auditor lines 415-490). Extract a JSON ARRAY of per-finding verdicts `{ index | signatureId+path+line, verdict: "confirmed"|"downgraded"|"disproved", confidence, reason }`. On ANY parse failure (garbage/truncated/wrong shape) return `{ ran:false, verified:[], downgraded:[], dropped:[] }`. On success, bucket each INPUT finding by its verdict; a finding with NO returned verdict defaults to `verified` (fail-closed — never silently drop an unaddressed finding). Return `ran:true`.

**Imports this file needs:** identical block to `security-auditor-agent.ts:1-21` minus the diff/scanner/supply-chain-specific imports; add nothing new (no new deps).

---

## 2. Patterns to Follow

### Fail-closed parse (INVERT the auditor's parser)
**Source:** `src/orchestrator/security-auditor-agent.ts`, lines 415-490 and 454
```ts
  // A JSON array is technically valid JSON but not a ReviewResult shape ...
  if (parsedJson && typeof parsedJson === "object" && !Array.isArray(parsedJson)) { ... return { review, parsed: true }; }
  // Fail-closed fallback — auditor ran but the response was NOT parseable.
  return { review: {...empty...}, parsed: false };
```
**Rule:** The auditor REJECTS arrays (it wants an object). The verifier is the mirror image — it EXPECTS a JSON array of per-finding verdicts; any non-array / truncated / garbage ⇒ `ran:false`. Reuse the same extraction ladder (direct `JSON.parse` → markdown-fence regex → first-`{`/`[`-to-last slice), lines 423-448.

### Read-only tool resolution for a curator-role agent
**Source:** `src/orchestrator/security-auditor-agent.ts`, lines 96-99; `src/orchestrator/tools/index.ts` line 64
```ts
const toolSet = resolveRoleTools("curator", projectRoot, graphState, graphDeps ?? undefined);
// ROLE_TOOLS.curator = ["read_file", "glob", "grep"]   (tools/index.ts:64) — NO bash/write/edit
```
**Rule:** Both finder and verifier resolve `"curator"` — this is the ONLY role that guarantees read-only (no `bash`/`write_file`/`edit_file`). Do NOT invent a new AgentRole (contract assumptions[1]).

### Abort-controlled, time-boxed sub-stage
**Source:** `src/orchestrator/security-auditor-agent.ts`, lines 186-209 (supply-chain seam; same at 121-122 and 159-163)
```ts
const scAbort = new AbortController();
const scTimer = setTimeout(() => scAbort.abort(), config.security?.timeoutMs ?? 300_000);
try { /* await stage with scAbort.signal */ } finally { clearTimeout(scTimer); }
```
**Rule:** The verifier stage in `runSecurityAudit` creates its OWN `AbortController` keyed to `config.security?.timeoutMs ?? 300_000` and passes `.signal` to `verify(...)`. This is how it "shares the time-box" — it is already inside the gate's `Promise.race` (`security-gate.ts:97-102`), and this inner controller gives it a real abort keyed to the same `timeoutMs`.

### runAgenticLoop with an abort signal
**Source:** `src/orchestrator/agentic-loop.ts`, lines 147, 504-511, 685-738
**Rule:** Pass `abortSignal: signal`. On abort the loop returns gracefully with `stopReason: "aborted"` (never throws — lines 504-511). A provider refusal surfaces as `result.refused === true` (lines 714, 180). Both map to `ran:false`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `deriveVerdict` | `security-audit-types.ts:84-86` | `(review: ReviewResult) => "pass"｜"blocked"` | Blocked iff `critical.length > 0`. USE UNCHANGED on the folded review. |
| `resolveModel` | `model-resolver.ts:106-109` | `(choice: string) => string` | Shorthand→modelId (`opus`→`claude-opus-4-8`). |
| `createClient` | `providers/factory.ts:192-198` | `(provider?, endpoint?, providerConfig?, model?, role?) => LLMClient` | Provider-agnostic client. Pass role `"SecurityVerifier"`. |
| `assembleSystemPrompt` | `agent-loader.ts:193-218` | `(role, agentName, projectRoot, ctx) => Promise<string>` | Loads `agents/<agentName>.md` + graph/env decoration. Pass `"curator"`, `"bober-security-verifier"`. |
| `resolveRoleTools` | `tools/index.ts:176-277` | `(role, projectRoot, ctx?, graphDeps?) => ToolSet` | Read-only curator toolset (`read_file/glob/grep`). |
| `getGraphState` / `getGraphDeps` | `tools/index.ts:130-150` | `(config?) => GraphState` / `() => deps｜null` | Graph gating snapshot (copy auditor lines 96-97). |
| `runAgenticLoop` | `agentic-loop.ts:382-407` | `(params: AgenticLoopParams) => Promise<AgenticLoopResult>` | The LLM loop. Supports `abortSignal` (147) + `budget` (50). |
| `budgetFromMaxUsd` | `workflow/budget.ts:148` | `(maxUsd: number｜null｜undefined) => Budget｜undefined` | Spend ceiling from `config.security.budget.maxUsd`. |
| `renderChangedFilesSection` | `security-auditor-agent.ts:284-304` | `(auditDiff?) => string` | Renders `## path (status)` + hunk content. It is FILE-LOCAL (not exported) — REPLICATE its hunk-rendering shape in `buildVerifierUserMessage`, or export it and reuse. |

**Types to import (do not redefine):** `SecurityFinding` (`security-audit-types.ts:50-57`), `ReviewResult`/`ReviewFinding` (`code-reviewer-agent.ts:17-37`), `AuditDiff`/`ChangedFile`/`DiffHunk`/`EMPTY_DIFF` (`security-knowledge/diff-provider.ts:26-44`), `SecurityAuditDeps` (`security-auditor-agent.ts:28-30`).

**Utilities reviewed:** `utils/`, `workflow/`, `security-knowledge/`, `tools/` — the verifier reuses `budgetFromMaxUsd`, `resolveModel`, `resolveRoleTools`, `assembleSystemPrompt`, `createClient`, `runAgenticLoop`; no other helper applies. Do NOT build a new model resolver, client factory, or parser ladder.

---

## 4. Prior Sprint Output

### Sprint 2: core finder (`runSecurityAudit` + `parseSecurityAuditResult`)
**Created/owns:** `src/orchestrator/security-auditor-agent.ts` — exports `runSecurityAudit`, `parseSecurityAuditResult`. The fail-closed `parsed:false ⇒ verdict:"blocked"` inversion lives at lines 248-253.
**Connection:** the verifier folds in between line 248 (finder parse) and line 253 (verdict).

### Sprint 3: fail-closed gate
**Owns:** `src/orchestrator/security-gate.ts` — wraps `runSecurityAudit` in `Promise.race([audit, timeout(config.security.timeoutMs)])` (lines 97-102). Never throws; every failure ⇒ `blocked:true`.
**Connection:** the verifier runs INSIDE `runSecurityAudit`, therefore INSIDE this race — no gate change needed. The `renderSecurityFeedback` at lines 223-257 reads `verdict.result.review.critical`; since the fold reduces that array, feedback automatically reflects the verified set.

### Sprint 6: `SecurityAuditDeps` + real diff (`AuditDiff`)
**Owns:** `deps` injection (auditor lines 28-30, 83) and `securityDiffProvider` / `AuditDiff` (`security-knowledge/diff-provider.ts`). `auditDiff` is computed ONCE (auditor lines 118-142) and is `undefined` in `estimated-files` mode.
**Connection:** add `verifier?` to `SecurityAuditDeps`; pass the SAME `auditDiff` value to `verify({ diff: auditDiff, ... })`.

### Sprint 7: supply-chain axis + optional-schema precedent
**Owns:** `security.supplyChain`/`egress` optional sub-objects (`schema.ts:275,280`) — the EXACT `.optional()`-no-outer-default pattern the `verifier` object must follow.
**Connection:** the two schema deep-equal tripwires (`schema.test.ts:645-654`, `705-715`) already gate this; your `verifier` must not leak into `parse({})`.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` content quoted here (the auditor agent references it at runtime). The governing principle for THIS sprint is fail-closed downgrade-only: an incomplete/ambiguous verification NEVER weakens the block.

### Architecture Decisions
Contract cites ADR-2/ADR-6 (default-off) for the verifier being opt-in. No new ADR file is required. The refutation methodology is sourced from the research doc (below), not a new ADR.

### Refutation framing — SOURCE for the agent prompt (`.bober/research/research-20260714-security-auditor-pentest-deep-upgrade-research.md`)
- Line 182: "**Finder → adversarial Refuter (told to DISPROVE, not confirm) → Verifier/Triage**, verifier in FRESH context with no shared history (kills anchoring/sycophancy)."
- Line 186: "reviewers pass a vuln MORE often when the change is framed as 'a security fix'... Bober hands the auditor the **sprint contract**, which frames the change favourably — a bias vector; **the verifier stage should not see it.**"
- Line 192: "hallucinated line numbers (require quoting the snippet at the claimed file:line; **verifier re-checks against the file**)... abstention + confidence as first-class REWARDED output fields."
- Line 204: "Because critical[] hard-blocks the sprint, raising recall without raising precision degrades the pipeline... **The verifier stage is therefore not optional polish — it is what makes higher recall safe to ship.**"
- Line 212 (W2): "adversarial refuter in fresh context, told to disprove; strip sprint-contract framing from the verifier; require source→sink→sanitizer + exploit narrative; abstention/confidence fields."

### The auditor agent to MIRROR (`agents/bober-security-auditor.md`)
Structure to copy: frontmatter `tools: [Read, Grep, Glob]` + `model: opus` (lines 4-8); `## Subagent Context` (13-51); `**IRON LAW**` block (56-62); `## Fail-Closed Parsing` (64-70); `## Red Flags — STOP` (135-141); `## What You Must Never Do` (143-152). For the verifier CHANGE: the task is REFUTATION (disprove each supplied finding, not audit files); it is NEVER shown the sprint contract or "already passed" framing; output is a JSON ARRAY of per-finding verdicts `{ confirmed | downgraded | disproved, confidence, reason }`, NOT a `ReviewResult`.

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/orchestrator/security-auditor-agent.test.ts` (mock block 23-58, fixtures 60-166)
```ts
const loopSpy = vi.fn();
const clientSpy = vi.fn(() => ({}) as never);
vi.mock("./agentic-loop.js", () => ({ runAgenticLoop: loopSpy }));
vi.mock("../providers/factory.js", () => ({ createClient: clientSpy }));
vi.mock("./model-resolver.js", () => ({ resolveModel: () => "model-test" }));
vi.mock("./agent-loader.js", () => ({ assembleSystemPrompt: vi.fn().mockResolvedValue("SYS") }));
// Uses the REAL resolveRoleTools/ROLE_TOOLS (only graph state stubbed) so the
// no-bash/write/edit assertion exercises the genuine role->tool mapping:
vi.mock("./tools/index.js", async () => {
  const actual = await vi.importActual<typeof ToolsIndexModule>("./tools/index.js");
  return { ...actual, getGraphState: () => ({ graphEnabled: false, engineHealth: "disabled" }), getGraphDeps: () => undefined };
});
const { runSecurityVerifier } = await import("./security-verifier-agent.js");
```
**Runner:** vitest. **Assertion:** `expect`. **Mock:** `vi.mock` factory + `vi.fn` spies (`loopSpy.mockResolvedValueOnce(...)`). **File naming:** co-located `*.test.ts`. `beforeEach` resets spies (test lines 160-166).

**Capture-the-prompt idiom** (for sc-8-2 "contract absent") — copy from test lines 299-304 / 561-564:
```ts
const userMessage = loopSpy.mock.calls[0][0].userMessage as string;
expect(userMessage).not.toContain("Sprint Contract");
expect(userMessage).not.toContain(testContract.title);
expect(userMessage).not.toContain(testContract.description);
expect(userMessage).not.toContain("Already Passed");
expect(userMessage).toContain(/* a finding description */);
```

**No-bash/write/edit idiom** (for the read-only invariant) — copy from test lines 429-458:
```ts
const toolNames = (loopSpy.mock.calls[0][0].tools as Array<{ name: string }>).map((t) => t.name);
expect(toolNames).toEqual(expect.arrayContaining(["read_file", "glob", "grep"]));
expect(toolNames).not.toContain("bash");
expect(toolNames).not.toContain("write_file");
expect(toolNames).not.toContain("edit_file");
const toolHandlers = loopSpy.mock.calls[0][0].toolHandlers as Map<string, unknown>;
expect(toolHandlers.has("bash")).toBe(false);
```

**deps.verifier injection idiom** (for the auditor fold tests) — mirror the `diffProvider` injection at test lines 554-558:
```ts
const fakeVerifier = { verify: vi.fn().mockResolvedValue({ verified:[], downgraded:[c], dropped:[], ran:true }) };
await runSecurityAudit(contract, evaluation, "/tmp/project", config, [], { verifier: fakeVerifier });
```

### E2E Test Pattern
Not applicable — this is a Node/orchestrator module. No Playwright.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/security-gate.ts` | `runSecurityAudit` (line 25,98) | medium | Reads `result.verdict` + `result.review.critical`; the fold reduces `critical`, so a downgraded/dropped critical correctly flips `reason:"critical-finding"`→`"clean"`. No code change, but its tests exercise the verdict. |
| `src/cli/commands/security-audit.ts` | `runSecurityAudit` | low | Standalone CLI path; default config omits `verifier` ⇒ byte-identical single-stage. |
| `src/orchestrator/security-hub.ts` | `SecurityAuditResult.review` | low | Emits `critical/important` to the hub; the folded review is the intended source. |
| `src/orchestrator/security-auditor-agent.test.ts` | `runSecurityAudit` | high | 40+ existing assertions call `runSecurityAudit` WITHOUT `verifier` config → the fold block must be skipped so `loopSpy` is still called exactly ONCE (tests assert `toHaveBeenCalledTimes(1)` at lines 299, 436, 489...). If the verifier ever runs in these, `loopSpy` fires twice and they break. |
| `src/config/schema.test.ts` | `SecuritySectionSchema` | high | Two deep-equal `parse({})` tripwires at lines 645-654 and 705-715 must stay green — `verifier` MUST be `.optional()` with NO outer default. |

### Existing Tests That Must Still Pass
- `security-auditor-agent.test.ts` sc-2/sc-5/sc-6/sc-7 suites (lines 168-820) — verify config without `verifier` ⇒ ONE `loopSpy` call, unchanged userMessage/verdict.
- `schema.test.ts` "SecuritySectionSchema — standalone validation (sc-1-1)" (642-698) and "SecuritySectionSchema.diff (sc-6-3)" (702-716) — `parse({})` deep-equals the exact 8-key object with NO `verifier`/`diff`/`supplyChain`/`egress` keys (`Object.hasOwn(parsed,"diff")===false` idiom at line 715).
- `security-gate.test.ts` (whatever exists) — gate verdict mapping unchanged.

### Features That Could Be Affected
- **Finder recall (sprints 1-7)** — shares `runSecurityAudit`. Verify the finder's prompt, model, maxTurns, tools, and single-pass verdict are byte-identical when `verifier` is absent.
- **Priority-hub emission (sprint 3/6)** — shares `SecurityAuditResult.review`; the folded (verified) review is what should be emitted.

### Recommended Regression Checks (run after implementation)
1. `npm run build` (tsc) — new file compiles; `SecurityAuditDeps.verifier?` type resolves.
2. `npm run typecheck` (if separate).
3. `npm run lint` — check `eslint.config.js` for `no-restricted-imports` boundaries; the verifier is orchestrator code, no network egress.
4. `npx vitest run src/orchestrator/security-auditor-agent.test.ts src/orchestrator/security-verifier-agent.test.ts src/config/schema.test.ts`
5. `npx vitest run` — full suite green (was ~4045 per project memory).

---

## 8. Implementation Sequence (dependency-ordered)

1. **`src/config/schema.ts`** — add the `verifier` OPTIONAL sub-object to `SecuritySectionSchema` (after `egress`, line 280), mirroring `diff`/`supplyChain`/`egress`:
   ```ts
   verifier: z.object({
     enabled: z.boolean().default(false),
     model: ModelChoiceSchema.default("opus"),
     maxTurns: z.number().int().min(1).default(10),
   }).optional(),
   ```
   - Verify: `SecuritySectionSchema.parse({})` STILL has no `verifier` key (deep-equal tripwires stay green); `parse({ verifier: {} })` yields `{ enabled:false, model:"opus", maxTurns:10 }`.

2. **`src/config/schema.test.ts`** — add a `describe("SecuritySectionSchema.verifier ...")` block: `parse({})` has no `verifier` key (`Object.hasOwn(parsed,"verifier")===false`); `parse({ verifier:{} })` defaults; round-trip `{ enabled:true, model:"sonnet", maxTurns:3 }`; reject `maxTurns:0`.
   - Verify: the two existing deep-equal tests at 645-654 and 705-715 STILL pass unchanged.

3. **`agents/bober-security-verifier.md`** — the refutation prompt. Mirror `agents/bober-security-auditor.md`; frontmatter `tools: [Read, Grep, Glob]`, `model: opus`; task = disprove each supplied finding; NEVER shown the contract; output a JSON ARRAY of `{ index|signatureId, verdict:"confirmed"|"downgraded"|"disproved", confidence, reason }`; fail-closed formatting note (truncated/prose ⇒ treated as ran-false ⇒ criticals kept).
   - Verify: `assembleSystemPrompt("curator","bober-security-verifier",root,ctx)` loads it (project-local `agents/` resolves first — `agent-loader.ts:114-121`).

4. **`src/orchestrator/security-verifier-agent.ts`** — types (`VerifierResult`, `VerifyParams`, `SecurityVerifier`), `runSecurityVerifier.verify`, `buildVerifierUserMessage` (findings + diff hunks, NO contract), `parseVerifierResult` (fail-closed array parse; unmatched finding ⇒ `verified`).
   - Verify: unit tests in step 5.

5. **`src/orchestrator/security-verifier-agent.test.ts`** — (a) verify() returns `VerifierResult` on a well-formed array; (b) read-only toolset (no bash/write/edit); (c) sprint-contract fields ABSENT from `userMessage`; (d) unparseable ⇒ `ran:false`; (e) `stopReason:"aborted"`/`refused` ⇒ `ran:false`.

6. **`src/orchestrator/security-auditor-agent.ts`** — add `verifier?` to `SecurityAuditDeps` (28-30); rename the finder parse to `const { review: finderReview, parsed } = ...` and hold `let review = finderReview`; insert the fold block after line 248, before line 253:
   ```ts
   let review = finderReview;
   if (parsed && config.security?.verifier?.enabled === true) {
     const verifier = deps.verifier ?? runSecurityVerifier;
     const vAbort = new AbortController();
     const vTimer = setTimeout(() => vAbort.abort(), config.security?.timeoutMs ?? 300_000);
     try {
       const vres = await verifier.verify({
         findings: [...finderReview.critical, ...finderReview.important],
         diff: auditDiff, projectRoot, config, signal: vAbort.signal,
       });
       review = foldVerifierResult(finderReview, vres);
     } finally { clearTimeout(vTimer); }
   }
   const verdict: "pass" | "blocked" = parsed ? deriveVerdict(review) : "blocked";
   ```
   Add `foldVerifierResult(finderReview, vres)`:
   ```ts
   function foldVerifierResult(fr: ReviewResult, v: VerifierResult): ReviewResult {
     if (!v.ran) return fr;                       // fail-closed: criticals kept
     const dropped = new Set(v.dropped);          // match by object identity (same refs passed in)
     const downgraded = new Set(v.downgraded);
     return {
       ...fr,
       critical: fr.critical.filter((c) => !dropped.has(c) && !downgraded.has(c)),
       important: [...fr.important.filter((i) => !dropped.has(i)), ...fr.critical.filter((c) => downgraded.has(c))],
       // minor + approvedAreas passed through UNTOUCHED — verifier never sees them:
       minor: fr.minor, approvedAreas: fr.approvedAreas,
     };
   }
   ```
   (Identity-set matching works because `verify` is fed and returns the SAME `SecurityFinding` object references. If you prefer value matching, key on `signatureId ?? path+line+description`.)
   - Verify: config WITHOUT `verifier` ⇒ fold block skipped ⇒ `review === finderReview`, one `loopSpy` call.

7. **`src/orchestrator/security-auditor-agent.test.ts`** — add the sc-8 fold/fail-closed/byte-identical suite (section below).

8. **Run full verification** — `npm run build`, `npm run lint`, `npx vitest run`.

### sc-8 tests to write (auditor test file)
- **sc-8-3 fail-closed:** inject `verifier.verify` resolving `{ ran:false }` (or a real-parse garbage path); a finder critical SURVIVES, `verdict:"blocked"`.
- **sc-8-4 fold:** finder review with 1 critical + 1 important + 1 approvedArea; inject `verify` returning that critical in `downgraded`; assert `review.critical` empty, `review.important` includes it, `approvedAreas` UNCHANGED, `verdict:"pass"`. Also assert the `findings` arg passed to `verify` EXCLUDES `approvedAreas`/`minor` (capture `fakeVerifier.verify.mock.calls[0][0].findings`).
- **sc-8-5 default-off + abort:** (a) config omitting `verifier` ⇒ `loopSpy` called ONCE, `review` deep-equals the finder review, verdict identical to a no-verifier run; (b) inject a `verify` that observes `signal` and resolves `{ ran:false }` (or throws) ⇒ criticals kept, `verdict:"blocked"`.
- **sc-8-6 FP-reduction demonstrative (the headline test):** case A — `verify` DISPROVES the finder critical (`dropped:[c]`) ⇒ `verdict` flips `blocked`→`pass`; case B — `verify` CONFIRMS it (`verified:[c]`) ⇒ `verdict` stays `blocked`.
- **read-only regression:** assert the real `runSecurityVerifier` (in the verifier test file) passes a `tools` array with no bash/write/edit.

---

## 9. Pitfalls & Warnings (invariants that MUST NOT regress)

- **Do NOT add `abortSignal` to the FINDER's `runAgenticLoop` call (lines 227-242).** It has none today. Adding one would change the finder-call params on the single-stage path and risk the "config-omitting-verifier ⇒ byte-identical" stop-condition (sc-8-5). The verifier stage owns its OWN `AbortController` keyed to the same `config.security.timeoutMs`. That IS the "shared time-box" in practice — both live inside the gate's `Promise.race` (`security-gate.ts:97-102`).
- **Downgrade-only, NEVER promote.** `foldVerifierResult` may move `critical→important` or drop, and may drop an `important`, but must NEVER move anything INTO `critical`. The new `critical` is a strict SUBSET of the finder's `critical`. No path adds a finding.
- **`ran:false` ⇒ return `finderReview` UNCHANGED.** Fail-closed. A parse failure, provider error, refusal, or abort in the verifier must KEEP the finder's criticals — never a silent pass. This is the mirror of the finder's own `parsed:false ⇒ blocked` (line 253).
- **The verifier NEVER sees `minor` or `approvedAreas`.** Feed `verify` only `critical + important`. `foldVerifierResult` passes `minor`/`approvedAreas` through byte-untouched (evaluatorNotes sc-8-4: "an approvedArea can never be re-opened").
- **The sprint contract must be PROVABLY absent from the verifier user message.** No `# Sprint Contract`, no `# Evaluation Result (Already Passed)`, no `contract.title/description/successCriteria`. Only findings + diff hunks. This is the sycophancy strip (research lines 186, 212) and is directly tested (sc-8-2).
- **`deriveVerdict` stays UNCHANGED** (`security-audit-types.ts:84-86`) and is applied to the FOLDED `review`.
- **Both finder and verifier resolve `resolveRoleTools("curator", ...)`** — never `bash`/`write_file`/`edit_file` (contract nonGoals[0]). No new `AgentRole` enum (assumptions[1]).
- **Schema tripwires:** `security.verifier` is `.optional()` with NO outer default (like `diff`/`supplyChain`/`egress` at `schema.ts:269,275,280`). If you give the OUTER `verifier` object a `.default(...)`, `SecuritySectionSchema.parse({})` gains a `verifier` key and BOTH deep-equal tests (`schema.test.ts:645-654`, `705-715`) fail.
- **`loopSpy` call-count in existing auditor tests:** the fold must be gated on `config.security?.verifier?.enabled === true`. All 40+ existing tests omit `verifier`, so they must continue to invoke `runAgenticLoop` exactly once. Injecting `deps.verifier` in the new sc-8 tests keeps the real verifier's second loop out of those assertions.
- **`auditDiff` may be `undefined`** (estimated-files mode, auditor line 118). `buildVerifierUserMessage` must handle `undefined` diff gracefully (render findings only) — the verifier still runs off the finding evidence.
- **Empty input findings** (finder found nothing critical/important): `verify` should return `{ verified:[], downgraded:[], dropped:[], ran:true }` (clean no-op) or the caller can skip the call — either way the folded review equals the finder review and the verdict is `pass`.
