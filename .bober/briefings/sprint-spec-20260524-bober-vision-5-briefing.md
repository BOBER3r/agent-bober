# Sprint Briefing: bober-code-reviewer agent + skill + advisory orchestrator wiring

**Contract:** sprint-spec-20260524-bober-vision-5
**Generated:** 2026-05-25T00:00:00.000Z

---

## Sprint Summary

This sprint adds a NEW read-only subagent — `bober-code-reviewer` — that runs **after** the evaluator returns `overallResult='pass'`. It writes an advisory markdown review to `.bober/reviews/<contractId>-review.md`. **Critical risk**: the orchestrator change is in `src/orchestrator/pipeline.ts` — the most blast-radius-heavy file in the codebase. The change MUST be **LOCALIZED** to a single decision point (the `if (evaluation.passed)` branch at `pipeline.ts:329`) and MUST be **advisory-only**: critical findings surface in the run-summary but do NOT trigger generator retry, do NOT fail the sprint, and do NOT mutate contract status. The reviewer's failure (crash/timeout) MUST log a warning and proceed — never block sprint completion. The new agent, the new skill, and the new test are additive; no existing evaluator-pass handler logic gets refactored.

---

## Reference Sources (per-file structural notes)

### `/tmp/superpowers/skills/requesting-code-review/code-reviewer.md`

**What to COPY (structural pattern):**
- The four-axis "What to Check" buckets: **Plan alignment / Code quality / Architecture / Testing / Production readiness** (lines 34-64). The bober variant should adapt these to: plan-vs-implementation alignment, DRY/YAGNI violations, dead code, missing tests, anti-pattern citations.
- The **Calibration** section (lines 66-75): "Not everything is Critical. Acknowledge what was done well before listing issues — accurate praise helps the implementer trust the rest of the feedback." Reproduce this discipline.
- The **Output Format → Strengths / Issues (Critical/Important/Minor) / Recommendations / Assessment** structure (lines 76-105). The bober ReviewMarkdown adopts the **same three severity tiers** plus an `Approved Areas` section (per contract s5-c5).
- The **Critical Rules → DO / DON'T** block (lines 107-121): include file:line refs, explain WHY, give a clear verdict; don't say "looks good" without checking, don't mark nitpicks as Critical.

**What NOT to copy verbatim:**
- Lines 7-12: `Task tool (general-purpose):` syntax — this is superpowers/Claude Code internal dispatch. Bober uses the **Agent SDK** through `runAgenticLoop` in `src/orchestrator/agentic-loop.ts`. The bober skill body should describe the Agent-tool dispatch the way `skills/bober.eval/SKILL.md:62-78` does (subagent_type: `bober-code-reviewer`, mode: auto).
- Lines 124-128 (placeholders block) and lines 132-168 (Example Output) are illustrative — adapt freely to bober's contract/eval-result inputs rather than `{BASE_SHA}`/`{HEAD_SHA}` placeholders. The bober reviewer reads the sprint contract from `.bober/contracts/<contractId>.json` and the eval result from `.bober/eval-results/<evalId>.json` — these become its sources of truth.

### `/tmp/superpowers/skills/requesting-code-review/SKILL.md`

**What to COPY (dispatch discipline):**
- The **When to Request Review** "Mandatory" list (lines 14-18): bober adapts this to "after each sprint when evaluator returns pass" (the orchestrator does the dispatch automatically).
- **Act on feedback** (lines 42-46): Critical fixed immediately, Important fixed before proceeding, Minor noted for later. The bober variant explicitly **demotes** the "Critical = block" rule — in bober's advisory mode, even Critical findings only surface in the run-summary.
- **Red Flags → Never** (lines 92-97) and **If reviewer wrong** (lines 98-102): these voice patterns slot directly into the bober Red Flags table.

**What NOT to copy verbatim:**
- Lines 26-30 (manual `git rev-parse HEAD~1` BASE_SHA shell snippet): in bober the orchestrator already knows the contract's base ref. The skill should describe this as orchestrator-driven, not user-driven.
- Lines 50-73 (the `[Just completed Task 2]` example): too specific to superpowers's manual workflow. Bober's reviewer is auto-spawned, not user-triggered.
- The "Integration with Workflows" section (lines 75-88) is superpowers-internal — replace with "Integration with bober pipeline: spawned after `runEvaluatorAgent` returns `passed: true` in `src/orchestrator/pipeline.ts`."

**Attribution requirement (per contract s5-c3):** Both new files (agent + skill) should attribute the structural pattern to obra/superpowers, matching the format used in `skills/bober.verify/SKILL.md:6-8` and `skills/bober.debug/SKILL.md:6-8`:
```
> Adapted from [obra/superpowers](https://github.com/obra/superpowers) — MIT License.
> Original: skills/requesting-code-review/.
> Adaptations: agent name (bober-code-reviewer), advisory-only contract, ReviewResult JSON schema, anti-pattern citations from .bober/anti-patterns/.
```

---

## `agents/bober-evaluator.md` pattern to mirror (EXACT structure for bober-code-reviewer.md)

The new agent file must structurally clone bober-evaluator.md. Use these line ranges as a clone-and-adapt map.

### YAML frontmatter (lines 1-20)
```yaml
---
name: bober-evaluator
description: Skeptical QA engineer that independently tests sprint output against contracts, produces structured feedback, and never writes or edits code.
tools:
  - Read
  - Bash
  - Grep
  - Glob
  - mcp__plugin_playwright_playwright__browser_navigate
  ...
model: sonnet
---
```

**For bober-code-reviewer.md (per contract s5-c1 — tools are READ-ONLY):**
```yaml
---
name: bober-code-reviewer
description: Advisory code reviewer that runs after evaluator pass, audits the sprint diff against contract + anti-pattern catalog, and emits a ReviewResult — never writes code, never blocks completion.
tools:
  - Read
  - Bash
  - Grep
  - Glob
model: sonnet
---
```
**DO NOT** add Write, Edit, or MultiEdit. **DO NOT** add Playwright MCP tools — the code reviewer is a static-analysis pass on the diff, not a UI verifier.

### Subagent Context block (lines 22-66)

Lines 22-35 establish: "You are being **spawned as a subagent** by the Bober orchestrator … isolated context window … NO access to the orchestrator's conversation history." Lines 30-34 enumerate the disk reads required (`.bober/contracts/<contractId>.json`, `bober.config.json`, `.bober/principles.md`). Lines 36-64 document the JSON response schema with the "Use EXACTLY this format" wording and the "IMPORTANT: You do NOT have Write or Edit tools" sentence at line 63.

**For bober-code-reviewer.md — mirror precisely:**
- Identical "spawned as a subagent" wording.
- Enumerate the disk reads relevant to review: contract, eval result (`.bober/eval-results/<evalId>.json`), `.bober/anti-patterns/README.md`, `.bober/principles.md`, and the git diff range.
- Add the "IMPORTANT: You do NOT have Write or Edit tools. Output the ReviewResult JSON in your response text, and the orchestrator will save it to `.bober/reviews/<contractId>-review.md`" sentence.

### Iron Law block (lines 70-80)
```
**IRON LAW:**

```
NO PASS WITHOUT INDEPENDENT VERIFICATION OF EVERY SUCCESS CRITERION
```

The generator's completion report is context, not proof. ...

<EXTREMELY-IMPORTANT>
If you cannot run a required strategy ..., the sprint FAILS with a configuration issue — NOT a soft "skipped with note" pass. ...
</EXTREMELY-IMPORTANT>
```

**For bober-code-reviewer.md — adapt Iron Law to advisory-review domain:**
```
**IRON LAW:**

```
NO REVIEW FINDING WITHOUT FILE:LINE EVIDENCE
```

A finding without a `path` + `line` + `snippet` in its evidence array is not a finding — it is an opinion. Drop it.

<EXTREMELY-IMPORTANT>
Style preferences, naming opinions (when names are consistent with the file), and theoretical risks without an observed trigger are NOT findings. Filing them is bikeshedding and pollutes the signal-to-noise ratio of the review.
</EXTREMELY-IMPORTANT>
```

### "The One Rule That Must Never Be Broken" block (lines 82-88)

Mirror the read-only enforcement language. For the reviewer, the rule becomes: "You NEVER write or edit code. You NEVER suggest specific fixes — you describe the problem, the evidence, and let the next sprint or maintainer choose the fix." Add: "You do NOT modify the contract status, you do NOT trigger retries, you do NOT block sprint completion. The orchestrator decides what to do with your findings."

### JSON schema documentation style (lines 36-61, 386-447)

Two passes: a **brief** schema in the Subagent Context block (lines 36-61) and a **full** schema in Step 7 (lines 386-447). Mirror both.

**For bober-code-reviewer.md, the ReviewResult schema (per contract s5-c2 + generatorNotes):**
```json
{
  "reviewId": "review-<contractId>-<timestamp>",
  "contractId": "<contract ID>",
  "specId": "<spec ID>",
  "timestamp": "<ISO-8601>",
  "summary": "<2-3 sentence overall assessment>",
  "critical": [
    {
      "description": "<what is wrong>",
      "evidence": [
        { "path": "<repo-relative>", "line": <N>, "snippet": "<≤120 chars>" }
      ],
      "antiPattern": "<optional: name from .bober/anti-patterns/ catalog>",
      "source": "<optional: catalog file path>"
    }
  ],
  "important": [ /* same shape */ ],
  "minor": [ /* same shape */ ],
  "approvedAreas": [
    "<short string naming a file/function/module that is well-done>"
  ]
}
```

### Red Flags table (lines 662-673)

Lines 662-673 use the pattern: heading `## Red Flags - STOP` followed by a bulleted list of "About to ..." footguns. **Mirror this exact heading and bullet style.**

**For bober-code-reviewer.md, Red Flags should call out:**
- About to file a finding with no `path` + `line` + `snippet` in its evidence array
- About to file a "naming" finding when the name is consistent with the surrounding file
- About to file a "could break in theory" finding with no observed trigger
- About to file a finding that re-litigates a clarification question the planner already resolved
- About to recommend a specific code fix (you describe the problem, not the solution)
- About to mark a finding `Critical` when it is a code-style or readability preference
- About to skip the `.bober/anti-patterns/README.md` cross-reference before classifying severity

### Rationalization Prevention table (lines 675-687)

Lines 675-687 use a two-column markdown table: `| Excuse | Reality |`. **Reproduce this exact table style.**

**For bober-code-reviewer.md:**
| Excuse | Reality |
|--------|---------|
| "This naming feels off" | Names are not findings. If the name is consistent with the file, drop it. |
| "This could break in some future edge case" | If you cannot show the trigger, it is not a finding. |
| "The implementer should have used X pattern" | Pattern preferences are not findings unless an anti-pattern in `.bober/anti-patterns/` is matched by name. |
| "I disagree with the planner's resolved clarification" | The clarification is settled. Re-litigating it is scope creep. |
| "Critical because I would have done it differently" | Critical means a bug, data-loss risk, or security hole — not a taste disagreement. |
| "Different words so rule doesn't apply" | Spirit over letter. |

### "What You Must Never Do" (lines 689-701)

Mirror this section style. Bullets must include: NEVER write or edit code; NEVER suggest specific fixes (describe problem only); NEVER mutate contract status; NEVER trigger a generator retry; NEVER block sprint completion; NEVER cite an anti-pattern name that is not in `.bober/anti-patterns/README.md`.

---

## `src/orchestrator/` map

### Evaluator-spawn site

**File:** `/Users/bober4ik/agent-bober/src/orchestrator/pipeline.ts`
**Function:** `runSprintCycle` (declared at line 116)
**Spawn line:** `pipeline.ts:322` — `const evaluation = await runEvaluatorAgent(evalHandoff, projectRoot, config);`

Note: `runEvaluatorAgent` is imported at `pipeline.ts:33` from `./evaluator-agent.js`. The runner itself lives at `/Users/bober4ik/agent-bober/src/orchestrator/evaluator-agent.ts:40-120`.

### THE ONE DECISION POINT — code-reviewer hook MUST go here

**File:** `/Users/bober4ik/agent-bober/src/orchestrator/pipeline.ts`
**Branch:** `pipeline.ts:329` — `if (evaluation.passed) {`
**Window:** lines 329-348 (the entire pass-branch). **The reviewer spawn goes INSIDE this branch, AFTER `updateContractStatus → "passed"`, AFTER `updateContract(...)`, AFTER the `sprint-passed` history event, and BEFORE the `return { contract: currentContract, evaluation, generatorResult: lastGeneratorResult };` on line 347.**

The exact surrounding code the generator must NOT modify, only insert AFTER:
```ts
// pipeline.ts:329-348 — DO NOT REFACTOR — only INSERT new code after the append history block
    if (evaluation.passed) {
      logger.success(`Sprint ${currentContract.contractId} passed all evaluations!`);

      currentContract = updateContractStatus(currentContract, "passed");
      currentContract = {
        ...currentContract,
        evaluatorFeedback: evaluation.summary,
      };
      await updateContract(projectRoot, currentContract);

      await appendHistory(projectRoot, {
        timestamp: new Date().toISOString(),
        event: "sprint-passed",
        phase: "complete",
        sprintId: currentContract.contractId,
        details: { iteration, feedback: evaluation.summary },
      });

      // ⇩ INSERT HERE — new advisory code-reviewer call (try/catch wrapped, never throws)

      return { contract: currentContract, evaluation, generatorResult: lastGeneratorResult };
    }
```

**Required shape of the insertion (advisory contract):**
```ts
// Sprint 5 — advisory code review (config-gated, time-boxed, never blocks)
try {
  const reviewTimeoutMs = config.codeReview?.timeoutMs ?? 300_000;
  await Promise.race([
    runCodeReviewer(currentContract, evaluation, projectRoot, config),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("code-review timeout")), reviewTimeoutMs),
    ),
  ]);
} catch (err) {
  logger.warn(
    `Code review skipped: ${err instanceof Error ? err.message : String(err)}`,
  );
  // Advisory only — sprint completion proceeds regardless.
}
```
**Critical constraints (per contract s5-c7 + s5-c9):**
- NO `if (criticalFindings.length > 0) { retry generator }` branch
- NO mutation of `currentContract.status` based on the review
- NO change to the `return` statement on line 347
- NO change to the evaluator-pass control flow above the insertion point

### Existing subagent-spawn mechanism — USE THIS EXACTLY

The orchestrator spawns subagents via in-process functions that wrap `runAgenticLoop` from `/Users/bober4ik/agent-bober/src/orchestrator/agentic-loop.ts:62-216`. The pattern is identical across `runCurator`, `runEvaluatorAgent`, `runGenerator`, `runArchitect`, `runResearch`.

**Use `src/orchestrator/curator-agent.ts` as the closest structural template** (read-only tools, writes output to `.bober/<dir>/`, parses JSON response, fallback on parse failure). Key signature and call pattern from `curator-agent.ts:57-87`:

```ts
// curator-agent.ts:57-87 — template for runCodeReviewer
export async function runCodeReviewer(
  contract: SprintContract,
  evaluation: EvaluationRunResult,  // pass the evaluator's full result so reviewer sees what already passed
  projectRoot: string,
  config: BoberConfig,
): Promise<ReviewResult> {
  const contractId = contract.contractId;
  logger.sprint(contractId, `Reviewing: ${contract.title}`);

  const reviewerModel = config.codeReview?.model ?? config.evaluator.model;
  const model = resolveModel(reviewerModel);
  const maxTurns = config.codeReview?.maxTurns ?? 15;

  const graphState = getGraphState(config);
  const graphDeps = graphState.engineHealth === "ready" ? getGraphDeps() : undefined;
  const toolSet = resolveRoleTools("evaluator", projectRoot, graphState, graphDeps ?? undefined);
  // Note: "evaluator" role is reused for tool-set (read-only). If reviewer becomes a
  // distinct role in src/orchestrator/tools/, that is a separate refactor — out of scope here.
  const systemPrompt = await assembleSystemPrompt("evaluator", "bober-code-reviewer", projectRoot, graphState);

  const client = createClient(
    config.codeReview?.provider ?? config.evaluator.provider ?? null,
    config.codeReview?.endpoint ?? config.evaluator.endpoint ?? null,
    config.codeReview?.providerConfig ?? config.evaluator.providerConfig,
    reviewerModel,
    "CodeReviewer",
  );

  // ... build user message (see curator-agent.ts:101-142 for the template)

  const result = await runAgenticLoop({
    client, model, systemPrompt, userMessage,
    tools: toolSet.schemas, toolHandlers: toolSet.handlers,
    maxTurns, maxTokens: 16384,
    onToolUse: (name, input) => { /* same logger.debug pattern */ },
  });

  return parseReviewResult(result.finalText, contractId);
}
```

**DO NOT** introduce a new abstraction (e.g. `spawnSubagent(...)`). DO NOT call the Anthropic SDK directly. Use `createClient` + `runAgenticLoop` exactly as the four existing runners do.

### Existing logging convention

`logger` is imported from `../utils/logger.js` (defined at `src/utils/logger.ts:1-60+`). Use these methods (already used throughout pipeline.ts):
- `logger.info(message)` — cyan info
- `logger.success(message)` — green check
- `logger.warn(message)` — yellow warn (use for reviewer crash/timeout)
- `logger.error(message)` — red error (do NOT use for review issues — advisory failures are warnings)
- `logger.debug(message)` — gray, verbose-only
- `logger.sprint(id, status)` — `[contractId] status`
- `logger.phase(name)` — banner heading

For advisory failure, use: `logger.warn(`Code review skipped: ${message}`);` — never `logger.error`, since failure does NOT fail the sprint.

For history, use the existing pattern from `pipeline.ts:339-346`:
```ts
await appendHistory(projectRoot, {
  timestamp: new Date().toISOString(),
  event: "code-review-complete",  // or "code-review-failed"
  phase: "complete",
  sprintId: currentContract.contractId,
  details: { /* counts of critical/important/minor findings, or error message */ },
});
```

### File-write convention for `.bober/<dir>/`

**There is no existing `eval-results/` write site in `src/`** — the evaluator agent emits JSON in its response text and the **orchestration skill layer** (`skills/bober.eval/SKILL.md:186`, `skills/bober.sprint/SKILL.md:350`, `skills/bober.run/SKILL.md:538`) is what saves it to disk during standalone runs. The pipeline.ts does not currently persist EvalResult to disk.

**For the reviewer**, follow the **briefing-state.ts pattern** (the closest analog — markdown file per contract under `.bober/<dir>/`):

```ts
// src/state/briefing-state.ts:5-29 — clone this shape
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir } from "./helpers.js";

const REVIEW_DIR = ".bober/reviews";

function reviewDir(projectRoot: string): string {
  return join(projectRoot, REVIEW_DIR);
}

function reviewPath(projectRoot: string, contractId: string): string {
  const safeId = contractId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(reviewDir(projectRoot), `${safeId}-review.md`);
}

export async function saveReview(
  projectRoot: string,
  contractId: string,
  content: string,
): Promise<void> {
  await ensureDir(reviewDir(projectRoot));  // mkdir -p semantics — idempotent
  const filePath = reviewPath(projectRoot, contractId);
  await writeFile(filePath, content, "utf-8");
}
```

**Alternative inline pattern** (closer to `curator-agent.ts:156-158` which writes directly with `node:fs/promises`):
```ts
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ensureDir } from "../utils/fs.js";

const absPath = resolve(projectRoot, `.bober/reviews/${safeContractId}-review.md`);
await ensureDir(resolve(absPath, ".."));
await writeFile(absPath, markdown, "utf-8");
```

Either works — pick one based on whether a new `src/state/review-state.ts` module is justified by reuse needs (test file will want a helper to read reviews back). The briefing-state.ts approach matches existing convention better.

**For `.bober/reviews/` directory creation idempotency (per evaluatorNotes):** use `ensureDir` (which is `mkdir(path, { recursive: true })` per `src/utils/fs.ts:45-47`) — equivalent to `mkdir -p`. If you add `"reviews"` to the SUBDIRS array in `src/state/index.ts:62`, `ensureBoberDir` will create it on every pipeline boot:
```ts
// src/state/index.ts:62 — minimal additive change
const SUBDIRS = ["contracts", "specs", "research", "designs", "outlines", "architecture", "briefings", "reviews"] as const;
```

---

## Config schema integration

**File:** `/Users/bober4ik/agent-bober/src/config/schema.ts`

**Existing pattern for adding a top-level knob with defaults** — `CuratorSectionSchema` at lines 122-130:
```ts
// schema.ts:122-130 — clone this shape
export const CuratorSectionSchema = z.object({
  model: ModelChoiceSchema.default("opus"),
  maxTurns: z.number().int().min(1).default(25),
  enabled: z.boolean().default(true),
  provider: z.string().optional(),
  endpoint: z.string().nullable().optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
});
export type CuratorSection = z.infer<typeof CuratorSectionSchema>;
```

**For `codeReview` — add IMMEDIATELY AFTER `CuratorSectionSchema` (after line 130):**
```ts
export const CodeReviewSectionSchema = z.object({
  timeoutMs: z.number().int().positive().default(300_000),
  enabled: z.boolean().default(true),
  model: ModelChoiceSchema.default("sonnet"),
  maxTurns: z.number().int().min(1).default(15),
  provider: z.string().optional(),
  endpoint: z.string().nullable().optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
});
export type CodeReviewSection = z.infer<typeof CodeReviewSectionSchema>;
```

**Then add it to `BoberConfigSchema` (line 199-209) as OPTIONAL — back-compat critical:**
```ts
export const BoberConfigSchema = z.object({
  project: ProjectSectionSchema,
  planner: PlannerSectionSchema,
  curator: CuratorSectionSchema.optional(),
  generator: GeneratorSectionSchema,
  evaluator: EvaluatorSectionSchema,
  sprint: SprintSectionSchema,
  pipeline: PipelineSectionSchema,
  commands: CommandsSectionSchema,
  graph: GraphSectionSchema.optional(),
  codeReview: CodeReviewSectionSchema.optional(),  // ⇩ ADD THIS LINE
});
```

**At the call site in pipeline.ts**, access defensively (mirrors curator pattern at `pipeline.ts:135` `config.curator?.enabled !== false`):
```ts
const reviewEnabled = config.codeReview?.enabled !== false;  // default-on, opt-out only
const reviewTimeoutMs = config.codeReview?.timeoutMs ?? 300_000;
```

**Default factory** (`createDefaultConfig` at `schema.ts:233-285`): the `codeReview` section is optional and defaults are inline at the schema — you do NOT need to add it to the `base` object on line 239-278 unless you want it materialized into freshly-generated config files. Mirror the `curator: { model: "opus", maxTurns: 25, enabled: true }` block on lines 249-253 if you want it materialized; otherwise leave it implicit.

---

## Test integration

### Test runner & location

**Test runner:** vitest. Confirmed at `package.json:scripts.test` → `"vitest"`. All test imports use:
```ts
import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
```

**Conventional test path:** `/Users/bober4ik/agent-bober/tests/orchestrator/`. Existing tests in that dir:
- `tests/orchestrator/curator-turn-count.test.ts` — uses mocked subagent loop
- `tests/orchestrator/gating.test.ts` — uses `vi.mock` for graph factory + temp directories

**Place the new test at:** `/Users/bober4ik/agent-bober/tests/orchestrator/code-reviewer.test.ts`

### Structural template from existing orchestrator test

From `tests/orchestrator/gating.test.ts:530-595` — temp-dir setup + JSONL readback + cleanup:
```ts
// gating.test.ts:530-595 — TEMPLATE: temp project root + assert file written
import { describe, it, expect, vi, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

describe("code-reviewer integration", () => {
  const tmpDirs: string[] = [];

  afterAll(async () => {
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("writes review file when evaluator returns pass", async () => {
    const tmpRoot = path.join(os.tmpdir(), `codeReview_${Date.now()}`);
    tmpDirs.push(tmpRoot);
    await fs.mkdir(path.join(tmpRoot, ".bober/reviews"), { recursive: true });

    // ... mock spawn, invoke runCodeReviewer, then:
    const filePath = path.join(tmpRoot, ".bober/reviews/<contractId>-review.md");
    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toContain("# Code Review:");
    expect(content).toContain("## Summary");
    expect(content).toContain("## Critical");
  });
});
```

From `tests/orchestrator/curator-turn-count.test.ts:21-33` — mocking a subagent collaborator:
```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/graph/pipeline-lifecycle.js", () => ({
  graphPipelineLifecycle: {
    engineHealth: vi.fn().mockReturnValue("ready"),
    getGraphClient: vi.fn().mockReturnValue(null),
    getGraphDeps: vi.fn().mockReturnValue(null),
  },
}));
```

### How to mock subagent spawn

The reviewer spawn calls `runAgenticLoop` (line 62 of `agentic-loop.ts`) which in turn calls `client.chat`. **Mock at the `client.chat` level** by mocking the provider factory, OR **mock `runCodeReviewer` itself** if the unit test is in pipeline-integration scope. The simpler path (matching contract s5-c6 — "mocks evaluator overallResult='pass', asserts code-reviewer is spawned with correct inputs"):

```ts
// Mock the runCodeReviewer function directly
vi.mock("../../src/orchestrator/code-reviewer-agent.js", () => ({
  runCodeReviewer: vi.fn().mockResolvedValue({
    reviewId: "review-test-1",
    contractId: "test-contract",
    summary: "Looks clean.",
    critical: [],
    important: [],
    minor: [],
    approvedAreas: ["src/foo.ts"],
  }),
}));

// Then in the test:
import { runCodeReviewer } from "../../src/orchestrator/code-reviewer-agent.js";
// ... invoke the pipeline path that hits the eval-pass branch
expect(runCodeReviewer).toHaveBeenCalledWith(
  expect.objectContaining({ contractId: "test-contract" }),
  expect.objectContaining({ passed: true }),
  tmpRoot,
  expect.any(Object),
);
```

### Three assertions required (per contract s5-c6)

1. **(a) Code-reviewer is spawned with correct inputs**: assert `runCodeReviewer` was called with the passed contract + the passing EvalResult.
2. **(b) Review file is written**: assert `.bober/reviews/<contractId>-review.md` exists on disk with the required sections (`# Code Review:`, `## Summary`, `## Critical`, `## Important`, `## Minor`, `## Approved Areas`).
3. **(c) On reviewer error, sprint still completes**: make the mock reject (`vi.fn().mockRejectedValue(new Error("boom"))`), then assert the pipeline path still returns successfully AND `logger.warn` was called AND the contract's status is still `"passed"` (NOT `"needs-rework"`).

### Filesystem write assertion pattern

From `tests/orchestrator/gating.test.ts:568-575`:
```ts
const filePath = path.join(tmpRoot, ".bober/reviews/<contractId>-review.md");
const content = await fs.readFile(filePath, "utf-8");
// Assert each required section heading exists
for (const heading of ["# Code Review:", "## Summary", "## Critical", "## Important", "## Minor", "## Approved Areas"]) {
  expect(content).toContain(heading);
}
```

---

## Advisory-only contract — code paths that MUST NOT be added

Per contract s5-c7 and s5-c9, these are explicit FORBIDDEN additions. The evaluator (the human one reviewing this sprint) will grep for them:

1. **NO control-flow branch from "critical findings present" to "retry generator":**
   - FORBIDDEN: `if (review.critical.length > 0) { continue; }` inside the iteration loop
   - FORBIDDEN: `if (review.critical.length > 0) { return runSprintCycle(...); }`
   - FORBIDDEN: any code that increments `iteration` based on review findings

2. **NO sprint failure branch:**
   - FORBIDDEN: `currentContract = updateContractStatus(currentContract, "needs-rework");` based on review
   - FORBIDDEN: `currentContract = updateContractStatus(currentContract, "failed");` based on review
   - The contract's `status` field is set to `"passed"` at line 332 BEFORE the reviewer runs — that status MUST NOT be downgraded by the reviewer

3. **NO contract status mutation:**
   - FORBIDDEN: any `await updateContract(projectRoot, currentContract);` call inside the reviewer's try block that changes `status` or `lastEvalId` or `evaluatorFeedback`

4. **NO change to the return statement:**
   - The `return { contract: currentContract, evaluation, generatorResult: lastGeneratorResult };` on `pipeline.ts:347` MUST be unchanged. The reviewer's output is NOT added to the return tuple. (If the run-summary needs critical findings, attach them via a side channel — e.g. an extra history event with the findings count — not via the function return.)

5. **NO refactor of the evaluator-pass handler:**
   - FORBIDDEN: extracting a new `handleEvaluatorPass(...)` function
   - FORBIDDEN: moving the `updateContractStatus → "passed"` / `updateContract` / `appendHistory("sprint-passed")` block into a helper
   - FORBIDDEN: changing the order of operations in lines 329-348
   - The only allowed change is **adding** new lines AFTER the `appendHistory({ event: "sprint-passed", ... })` block and BEFORE the `return`

6. **NO Write or Edit tools on the agent:**
   - FORBIDDEN in `agents/bober-code-reviewer.md` YAML: `Write`, `Edit`, `MultiEdit`, or any `mcp__plugin_playwright_*` tools. Tools field MUST contain ONLY `Read, Bash, Grep, Glob`.

---

## Verification checklist — the generator self-verifies each criterion

After implementation, the generator must run each of these checks BEFORE declaring done:

### s5-c1 — agent YAML & tools
```bash
head -20 /Users/bober4ik/agent-bober/agents/bober-code-reviewer.md
# Confirm: name: bober-code-reviewer, description present, model: <choice>
# Confirm: tools list contains EXACTLY [Read, Bash, Grep, Glob]
grep -E "Write|Edit|MultiEdit|playwright" /Users/bober4ik/agent-bober/agents/bober-code-reviewer.md
# Confirm: NO matches in the frontmatter section
```

### s5-c2 — Subagent Context + Iron Law + Red Flags + Rationalization + ReviewResult schema
```bash
grep -n "Subagent Context\|IRON LAW\|Red Flags\|Rationalization\|reviewId" /Users/bober4ik/agent-bober/agents/bober-code-reviewer.md
# Confirm: all five headings/keys present, line numbers in expected order (Subagent Context near top, JSON schema after)
```

### s5-c3 — skill body
```bash
head -10 /Users/bober4ik/agent-bober/skills/bober.code-review/SKILL.md
# Confirm: --- frontmatter, name: bober-code-review, description starts with "Use when completing a sprint, after evaluator pass"
grep -n "DRY\|YAGNI\|dead code\|missing tests\|anti-patterns/\|What NOT to flag\|style preferences\|naming\|obra/superpowers" /Users/bober4ik/agent-bober/skills/bober.code-review/SKILL.md
# Confirm: each of those terms is present in the body
```

### s5-c4 — orchestrator integration is localized + advisory
```bash
grep -n "bober-code-reviewer\|runCodeReviewer\|code-review" /Users/bober4ik/agent-bober/src/orchestrator/pipeline.ts
# Confirm: matches are concentrated near pipeline.ts:329-348 (the eval-pass branch)
git diff src/orchestrator/pipeline.ts | wc -l
# Confirm: well under 150 lines of diff
git diff src/orchestrator/pipeline.ts | grep -E "^-" | grep -v "^---"
# Confirm: minimal or zero deletions — almost pure additions
```

### s5-c5 — review markdown schema
```bash
# After running a test that produces a review file:
cat /tmp/<test-tmp>/.bober/reviews/<contractId>-review.md | head -30
# Confirm headings present in order: # Code Review:, ## Summary, ## Critical, ## Important, ## Minor, ## Approved Areas
```

### s5-c6 — unit test
```bash
npm run test -- tests/orchestrator/code-reviewer.test.ts
# Confirm: exit 0
# Confirm test file asserts the THREE contract points (spawn inputs, file written, error → sprint still completes)
grep -E "toHaveBeenCalledWith|readFile.*reviews|mockRejectedValue" /Users/bober4ik/agent-bober/tests/orchestrator/code-reviewer.test.ts
```

### s5-c7 — advisory-only verified
```bash
grep -nE "critical.*retry|needs-rework.*review|updateContractStatus.*review" /Users/bober4ik/agent-bober/src/orchestrator/pipeline.ts
# Confirm: NO matches
grep -n "iteration" /Users/bober4ik/agent-bober/src/orchestrator/pipeline.ts
# Confirm: the `iteration` variable is NOT incremented or referenced within the review try-block
```

### s5-c8 — full eval suite
```bash
npm run typecheck && npm run lint && npm run build && npm run test
# All four must exit 0
```

### s5-c9 — diff localization
```bash
git diff --stat src/orchestrator/
# Confirm: pipeline.ts shows a small change (<50 lines net); no other src/orchestrator/ file modified except (acceptable) src/orchestrator/code-reviewer-agent.ts (NEW file)
git diff src/orchestrator/pipeline.ts | grep -E "^[+-]" | grep -v "^[+-]{3}" | wc -l
# Confirm: change is concentrated, not sprawling
```

### Sprint 4 cross-check (per evaluatorNotes)
```bash
ls /Users/bober4ik/agent-bober/.bober/anti-patterns/
# Confirm: README.md, testing-anti-patterns.md, condition-based-waiting.md, root-cause-tracing.md, defense-in-depth.md all present
grep -c "\.bober/anti-patterns/" /Users/bober4ik/agent-bober/skills/bober.code-review/SKILL.md
# Confirm: ≥1 — the skill body cites the catalog by path
grep -c "\.bober/anti-patterns/" /Users/bober4ik/agent-bober/agents/bober-code-reviewer.md
# Confirm: ≥1 — the agent prompt references the catalog
```

### `.bober/reviews/` idempotency
```bash
# Confirm directory creation uses mkdir -p semantics
grep -n "mkdir.*recursive\|ensureDir.*reviews\|ensureBoberDir" /Users/bober4ik/agent-bober/src/orchestrator/code-reviewer-agent.ts /Users/bober4ik/agent-bober/src/state/index.ts
# Confirm: at least one of: SUBDIRS includes "reviews" (state/index.ts:62), OR ensureDir is called before writeFile
```

---

## Pitfalls & Warnings

- **`.bober/reviews/` does not exist on disk** as of this briefing. Confirmed by `ls`. First test run will create it; ensure `ensureDir`/`mkdir -p` is called before any `writeFile`.
- **The pipeline does NOT currently persist EvalResult to disk.** The evaluator agent returns JSON in its response text, and only the standalone skill orchestrator (bober.eval / bober.sprint / bober.run) writes `.bober/eval-results/<evalId>.json`. So if the reviewer prompt says "read the eval result from `.bober/eval-results/<evalId>.json`", that file may not exist in pipeline-driven runs. Solution: **pass the EvaluationRunResult object into the reviewer's prompt directly** (serialized as JSON in the user message), the same way `runEvaluatorAgent` passes `programmaticResults` into its prompt at `evaluator-agent.ts:159-177`.
- **Do not add a new tool role.** The reviewer is read-only — reuse the `"evaluator"` role from `src/orchestrator/tools/` (which already removes Write/Edit). Adding a new role triggers a refactor across `tools/index.ts` and `ROLE_TOOLS`, blowing past the LOCALIZED constraint.
- **The `evaluator-agent.ts` file is OFF-LIMITS.** Sprints 3 and 4 modified it. Per generatorNotes: "DO NOT modify bober-evaluator.md in this sprint."
- **`runEvaluatorAgent` runtime currently has no timeout.** The reviewer MUST add its own `Promise.race` timeout — don't trust the agentic loop to bound itself.
- **Iron Law style:** Sprint 3 standardized the Iron Law block format (lines 70-80 of bober-evaluator.md). Use the same `**IRON LAW:**` heading followed by a triple-backticks code block with capitalized rule. Do NOT use `## Iron Law` (different style).
- **Voice consistency:** Sprint 3 voice pass added Red Flags + Rationalization Prevention tables to 5 agents in the verbatim-style. Match that style EXACTLY — the bober-evaluator.md tables at lines 662-687 are the reference.
- **JSON parsing fallback:** the `parseEvalResult` function in `evaluator-agent.ts:279-350` shows the canonical resilient JSON-parsing pattern (try direct, try ```` ```json ```` fences, try `{...}` slice, fall through to error result). Clone this exact pattern in `parseReviewResult`. Do not roll your own.
- **Logger interface:** `logger.warn` exists (used at `pipeline.ts:250`, `pipeline.ts:351`). `logger.success` exists. There is NO `logger.review` method — use `logger.info` for normal review-complete messages and `logger.warn` for skip/timeout/crash messages.
- **The contract states "agents/bober-code-reviewer.md" — singular path with hyphens.** Match exactly, not `bober_code_reviewer.md` or `bober.code-reviewer.md`. Same for `skills/bober.code-review/SKILL.md` — dot in skill name, hyphen in review.
- **`config.codeReview?.timeoutMs ?? 300_000`** — use optional chaining + nullish coalescing. The `codeReview` section MUST be optional in BoberConfigSchema (per generatorNotes back-compat requirement), so existing `bober.config.json` files without the section keep working.
- **Skill description prefix:** contract s5-c3 says the description MUST start with `"Use when completing a sprint, after evaluator pass"`. Match this prefix verbatim — the evaluator will grep for it.
