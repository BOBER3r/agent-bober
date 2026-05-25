# Sprint Briefing: Checkpoint artifact diff renderer per artifact type

**Contract:** `sprint-spec-20260524-bober-vision-11`
**Generated:** 2026-05-25T12:00:00Z
**Tier:** 2 (sprint 5/8 — first of the polish/integration sub-batch)
**Depends on:** Sprint 10 (PR mechanism w/ `renderCheckpointComment`), Sprint 9 (disk mechanism w/ `summarizeArtifact`), Sprint 8 (CLI mechanism w/ `renderArtifact`).

---

## 0. Sprint Summary

Build a **per-artifact-type renderer registry** at `src/orchestrator/checkpoints/renderers/` (9 renderers + 1 registry + colocated tests), then replace the **three generic renderers** that Sprints 8, 9, and 10 inlined inside their mechanism files:

| Mechanism file | Inlined function to replace | Lines (current) |
|----------------|-----------------------------|-----------------|
| `src/orchestrator/checkpoints/mechanisms/cli.ts` | `renderArtifact(checkpoint, artifact)` | 39–80 |
| `src/orchestrator/checkpoints/mechanisms/disk.ts` | `summarizeArtifact(artifact)` (4-field whitelist) | 36–56 |
| `src/orchestrator/checkpoints/mechanisms/pr.ts` | `renderCheckpointComment(...)` (instance method) | 381–408 |

After this sprint, all three mechanisms delegate to **one** call: `render(artifact)` from `renderers/registry.ts`, which dispatches on `artifact.type`.

**THREE CRITICAL CONSTRAINTS TO RESOLVE FIRST**

1. **COLOCATED tests, NOT `tests/`** — the contract's `expectedChanges` says `tests/orchestrator/checkpoints/renderers/`. That path is **WRONG**. Sprints 5/7/8/9/10 ALL colocated tests next to their source (`cli.test.ts` next to `cli.ts`, `disk.test.ts` next to `disk.ts`, `pr.test.ts` next to `pr.ts`). The Sprint 5 scanner enforces `colocated >= separate` ratio. Each renderer test must sit at `src/orchestrator/checkpoints/renderers/<name>.test.ts` — colocated with its source. Success criterion `s11-c10` says "Locate tests/orchestrator/..." but evaluator practice has accepted colocated tests in every prior Tier 2 sprint; locate-by-grep works either way.

2. **Pure functions, no I/O** — `generatorNotes` explicitly: "Renderers are pure functions: artifact in, string (markdown) out. No side effects, no file IO, no network — just parsing and formatting." The ONE exception is `generator-diff.ts` which the contract says MAY shell out to `git diff --stat` — keep that I/O inside `generator-diff.ts` only; all other renderers stay pure.

3. **Canonical `artifact.type` discriminator** — the registry dispatches on `artifact.type`. The current mechanisms read `art["type"]` opportunistically (disk.ts:51, pr.ts:389) but no formal enum exists. **You must define the canonical artifact-type string set** in `renderers/registry.ts`:
   `"research" | "plan-spec" | "sprint-contract" | "curator-briefing" | "generator-diff" | "eval-result" | "code-review" | "sprint-summary" | "pipeline-summary"`.
   Unknown types fall back to a generic text dump with a `stderr` warning (s11-c2).

---

## 1. Target Files

### `src/orchestrator/checkpoints/renderers/registry.ts` (create)

**Directory pattern:** New directory `renderers/` colocated with `mechanisms/` under `src/orchestrator/checkpoints/`. Same kebab-case singular filenames as `mechanisms/`.

**Most similar existing file:** `src/orchestrator/checkpoints/registry.ts` (lines 1–91) — a module-level `Map` + `register*` / `get*` helpers + self-registration at module init. Mirror that structure exactly.

**Structure template (mirrors checkpoints/registry.ts):**
```ts
/**
 * Per-artifact-type renderer registry.
 *
 * Renderers are pure functions: (artifact) => markdown string.
 * Mechanisms (cli/disk/pr) call render(artifact) to get a human-readable
 * summary instead of stringifying the full artifact.
 *
 * Sprint 11 — replaces inline renderArtifact (cli), summarizeArtifact (disk),
 * renderCheckpointComment (pr) bodies.
 */

import { renderResearch } from "./research.js";
import { renderPlanSpec } from "./plan.js";
import { renderSprintContract } from "./sprint-contract.js";
import { renderCuratorBriefing } from "./curator-briefing.js";
import { renderGeneratorDiff } from "./generator-diff.js";
import { renderEvalResult } from "./eval-result.js";
import { renderCodeReview } from "./code-review.js";
import { renderSprintSummary } from "./sprint-summary.js";
import { renderPipelineSummary } from "./pipeline-summary.js";

/** Canonical artifact type strings. CLI/disk/PR mechanisms MUST pass artifact.type matching one of these. */
export type ArtifactType =
  | "research"
  | "plan-spec"
  | "sprint-contract"
  | "curator-briefing"
  | "generator-diff"
  | "eval-result"
  | "code-review"
  | "sprint-summary"
  | "pipeline-summary";

export type Renderer = (artifact: unknown) => string;

const renderers = new Map<string, Renderer>([
  ["research", renderResearch],
  ["plan-spec", renderPlanSpec],
  ["sprint-contract", renderSprintContract],
  ["curator-briefing", renderCuratorBriefing],
  ["generator-diff", renderGeneratorDiff],
  ["eval-result", renderEvalResult],
  ["code-review", renderCodeReview],
  ["sprint-summary", renderSprintSummary],
  ["pipeline-summary", renderPipelineSummary],
]);

/**
 * Dispatch to the correct renderer by artifact.type.
 * Unknown types fall through to a generic JSON text dump + stderr warning (s11-c2).
 */
export function render(artifact: unknown): string {
  const a = artifact as { type?: unknown } | null | undefined;
  const type = a && typeof a === "object" && typeof a.type === "string" ? a.type : null;
  if (type !== null && renderers.has(type)) {
    return renderers.get(type)!(artifact);
  }
  process.stderr.write(
    `warn: renderer registry has no entry for artifact.type=${JSON.stringify(type)}; falling back to generic JSON dump.\n`,
  );
  return renderGeneric(artifact);
}

/** Generic fallback — single source of truth for unknown-type rendering. */
export function renderGeneric(artifact: unknown): string {
  const json = JSON.stringify(artifact, null, 2) ?? String(artifact);
  return ["```json", json, "```"].join("\n");
}
```

**Test file:** colocated at `src/orchestrator/checkpoints/renderers/registry.test.ts` — covers (a) each `type` dispatches to the right renderer (use mock renderers via dependency injection or just snapshot a tiny artifact), (b) unknown type falls through to generic + emits stderr warning.

---

### `src/orchestrator/checkpoints/renderers/research.ts` (create) — s11-c3

**Artifact shape (from `.bober/research/research-20260524-superpowers-vs-agent-bober.md`):**
Research is **a markdown FILE on disk**, not a JSON object. The artifact passed at the checkpoint (per `sites.ts:25-28`) is `researchDoc: ResearchDoc` — but the inline shape passed at `pipeline.ts:485` is just the doc itself. Renderers must handle **both modes** (per `generatorNotes`: "Parse them from disk by reading the path in artifact.path, or accept inline artifact data when provided"). For research, the simplest shape to expect at this checkpoint is:
```ts
{ type: "research", path?: string, content?: string, text?: string }
```

**What to extract (s11-c3):**
- **title** from H1 (first line matching `^# (.+)$`) — e.g., from line 1: `Research: obra/superpowers — what to port into agent-bober`
- **assumptions count** — by section heading match, count list items under `## Assumptions` if present (this research doc has none; mark `0`)
- **files explored count** — look for `**Files Explored:** N` (line 7) OR count files in `### Key Files` section
- **key findings count** — section count under `## Existing Patterns` or `## Key Findings`
- **first 3 lines of executive summary** — first 3 non-blank lines after the first `---` separator (in the sample: lines 13+ "## Architecture Overview" → not the exec summary; but the leading `> Note:` callout works as summary)
- **truncation marker** if total source >500 lines:
  `... <N more lines truncated, see <path>:<startLine> for full content>`

**Output skeleton (markdown):**
```ts
export function renderResearch(artifact: unknown): string {
  const { content, path } = extractContent(artifact); // pure helper, no I/O
  const title = extractH1(content) ?? "(untitled research)";
  const assumptions = countSection(content, "Assumptions");
  const filesExplored = parseInlineCount(content, /\*\*Files Explored:\*\*\s+(\d+)/) ?? 0;
  const findings = countSection(content, "Existing Patterns") + countSection(content, "Key Findings");
  const execSummary = firstNNonBlank(content, 3, /^---$/);

  const lines = [
    `## Research: ${title}`,
    ``,
    `- **Assumptions:** ${assumptions}`,
    `- **Files explored:** ${filesExplored}`,
    `- **Key findings:** ${findings}`,
    ``,
    `### Executive summary`,
    ...execSummary,
    ``,
  ];
  return applyLineCap(lines.join("\n"), 500, path);
}
```

---

### `src/orchestrator/checkpoints/renderers/plan.ts` (create) — s11-c4

**Artifact shape (from `.bober/specs/spec-20260524-bober-vision.json` lines 1–73):**
A `PlanSpec` JSON object. Schema is `src/contracts/spec.ts:124-170`. The checkpoint passes the PARSED OBJECT directly (`pipeline.ts:621` passes `spec`). Fields to extract:
- `title` (line 6: `"Bober Vision: Multi-mode software engineering teammate"`)
- `ambiguityScore` (line 11: `5`)
- `features.length` (line 73+, an array of FeatureSpec)
- `sprints` count — `sprints` is optional (line 159 in schema); if absent, scan `.bober/contracts/sprint-*.json` count is OUT OF SCOPE (renderer is pure — only read fields off the artifact)
- `assumptions[]` (line 45+, array of strings)
- `outOfScope[]` (line 59+, array of strings)

**Required `type` discriminator:** add a tag — when `pipeline.ts:621` wraps the artifact, it should pass `{ type: "plan-spec", ...spec }` OR the registry can sniff `specId` to infer type. **Recommendation:** keep registry strict (require `type` field) and update mechanism wrappers to set it. See section 5 below for wrapper changes.

**Output skeleton:**
```ts
export function renderPlanSpec(artifact: unknown): string {
  const spec = artifact as PlanSpec & { type: "plan-spec" };
  const lines = [
    `## Plan: ${spec.title ?? "(untitled)"}`,
    ``,
    `- **Spec ID:** \`${spec.specId}\``,
    `- **Status:** ${spec.status}`,
    `- **Ambiguity:** ${spec.ambiguityScore ?? "n/a"}/10`,
    `- **Features:** ${spec.features?.length ?? 0}`,
    `- **Sprints (inline):** ${(spec.sprints as unknown[] | undefined)?.length ?? 0}`,
    ``,
    `### Assumptions (${spec.assumptions?.length ?? 0})`,
    ...(spec.assumptions ?? []).map((a) => `- ${a}`),
    ``,
    `### Out of scope (${spec.outOfScope?.length ?? 0})`,
    ...(spec.outOfScope ?? []).map((o) => `- ${o}`),
  ];
  return applyLineCap(lines.join("\n"), 300);
}
```

**Cap:** <300 lines.

---

### `src/orchestrator/checkpoints/renderers/sprint-contract.ts` (create) — s11-c5

**Artifact shape (from `.bober/contracts/sprint-spec-20260524-bober-vision-10.json`):**
A `SprintContract` JSON object (schema `src/contracts/sprint-contract.ts:82-134`). Fields to extract:
- `contractId` (line 2: `"sprint-spec-20260524-bober-vision-10"`)
- `feature` (line 4 in contract 10) OR `title` (Sprint contracts have BOTH `feature` and `title` keys — check both)
- `expectedChanges[]` (line 62–66) — list of `{ path, action, description }`
- `successCriteria` count + **first 5** with id+description
- `dependsOn[]` (line 67)

**Output skeleton:**
```ts
export function renderSprintContract(artifact: unknown): string {
  const c = artifact as SprintContract & { type: "sprint-contract"; feature?: string; expectedChanges?: Array<{path: string; action: string}> };
  const sc = c.successCriteria ?? [];
  const ec = c.expectedChanges ?? [];
  const lines = [
    `## Sprint Contract: \`${c.contractId}\``,
    ``,
    `**Feature:** ${c.feature ?? c.title ?? "(untitled)"}`,
    ``,
    `### Expected changes (${ec.length})`,
    ...ec.map((e) => `- \`${e.path}\` (${e.action})`),
    ``,
    `### Success criteria (${sc.length}, first 5 shown)`,
    ...sc.slice(0, 5).map((s) => `- **${s.criterionId ?? (s as any).id}**: ${s.description}`),
    ``,
    `### Depends on`,
    ...(c.dependsOn ?? []).map((d) => `- \`${d}\``),
  ];
  return applyLineCap(lines.join("\n"), 200);
}
```

**Cap:** <200 lines.

---

### `src/orchestrator/checkpoints/renderers/curator-briefing.ts` (create)

**Artifact shape (from `.bober/briefings/sprint-spec-20260524-bober-vision-9-briefing.md`):**
A **markdown FILE** (mirrors research). Briefings are emitted by curator with the structure:
```
# Sprint Briefing: <title>
**Contract:** `<contractId>`
**Generated:** <ISO>
...
## 0. Sprint Summary
## 1. Target Files
## 2. Patterns to Follow
... (etc up to ## 9)
```

Artifact shape (recommended): `{ type: "curator-briefing", path?: string, content?: string }`.

**What to show:**
- title (H1)
- contract id (line 3 match `**Contract:** \`(.+?)\``)
- count of `## ` sections
- first 3 lines of `## 0. Sprint Summary` body
- file paths cited (count of `\`\.bober|src\/` or `\`<file>\`` patterns)
- truncate if source >300 lines

---

### `src/orchestrator/checkpoints/renderers/generator-diff.ts` (create) — s11-c6

**Artifact shape:** The handoff/post-sprint checkpoint passes generator results. Sample at `.bober/handoffs/gen-report-sprint-spec-20260524-bober-vision-10-1.json`:
```json
{
  "contractId": "sprint-spec-20260524-bober-vision-10",
  "iteration": 1,
  "status": "complete",
  "commit": "d3264d1",
  "filesChanged": [
    { "path": "src/orchestrator/checkpoints/mechanisms/pr.ts", "action": "created" },
    ...
  ],
  ...
}
```

Recommended artifact: `{ type: "generator-diff", commit?: string, baseRef?: string, filesChanged?: Array<{path, action}> }`.

**What to show (s11-c6):**
- `git diff --stat <base>..<head>` output
- list of files: created / modified / deleted (by action)
- commit count: `git rev-list --count <base>..<head>`
- **truncate per-file diff at 50 lines per file with marker**
- **SKIP BINARY FILES** — `evaluatorNotes`: "verify generator-diff renderer SKIPS binary files (rendering binary as text breaks PR comments and CLI terminals). Test: include a binary file in the fixture, verify it's listed but not rendered inline."

**I/O exception:** This renderer is the **only one** allowed to shell out (per `generatorNotes`). Use `execa("git", ["diff", "--stat", ...])`. Keep the `git` shell call inside a single helper function so tests can mock at the seam (mirror the `GhClient` interface pattern in `pr.ts:29-44`).

**Binary file detection:** `git diff --numstat` returns `-\t-\t<path>` for binary files. Use numstat first, filter binary, then `git diff --unified=3 <path>` per text file.

```ts
interface GitClient {
  diffStat(base: string, head: string, cwd: string): Promise<string>;
  diffNumstat(base: string, head: string, cwd: string): Promise<Array<{ added: string; deleted: string; path: string }>>;
  diffFile(path: string, base: string, head: string, cwd: string): Promise<string>;
  revListCount(base: string, head: string, cwd: string): Promise<number>;
}
```

**Cap:** Per-file ≤50 lines + truncation marker. No overall cap mandated but evaluator notes line caps are MAXIMUMS — 100–200 total is appropriate.

---

### `src/orchestrator/checkpoints/renderers/eval-result.ts` (create) — s11-c7

**Artifact shape (from `.bober/eval-results/eval-sprint-spec-20260524-bober-vision-10-2.json`):**
Schema is `src/contracts/eval-result.ts:60-75`. Sample structure:
```json
{
  "evalId": "...", "contractId": "...", "iteration": 2,
  "overallResult": "pass",
  "score": { "criteriaTotal": 9, "criteriaPassed": 9, "criteriaFailed": 0, ... },
  "strategyResults": [
    { "strategy": "typecheck", "required": true, "result": "pass", "output": "tsc --noEmit exit 0" },
    ...
  ],
  "criteriaResults": [
    { "criterionId": "s10-c1", "result": "pass", "evidence": "..." },
    ...
  ],
  "regressions": [], "generatorFeedback": [], "summary": "..."
}
```

**What to show (s11-c7):**
- `overallResult` (top-level — NOT a schema field; some eval results use `overallResult`, others use `passed: boolean` — handle both)
- `score` (passed/failed/total)
- failing criteria with their `verificationMethod` (look up from contract — but renderer is pure; instead show `criterionId` + `feedback`)
- strategy results — **exit codes ONLY, no full stdout** ("strategy outputs (exit codes only, no full stdout)")

**Cap:** <300 lines.

```ts
export function renderEvalResult(artifact: unknown): string {
  const e = artifact as { type: "eval-result"; overallResult?: string; passed?: boolean; score?: { criteriaPassed: number; criteriaFailed: number; criteriaTotal: number }; strategyResults?: Array<{ strategy: string; result: string }>; criteriaResults?: Array<{ criterionId: string; result: string; feedback?: string }> };
  const overall = e.overallResult ?? (e.passed ? "pass" : "fail");
  const failing = (e.criteriaResults ?? []).filter((c) => c.result !== "pass");
  const lines = [
    `## Eval Result: **${overall.toUpperCase()}**`,
    ``,
    `- **Score:** ${e.score?.criteriaPassed ?? 0}/${e.score?.criteriaTotal ?? 0} (${e.score?.criteriaFailed ?? 0} failed)`,
    ``,
    `### Strategies`,
    ...(e.strategyResults ?? []).map((s) => `- \`${s.strategy}\`: ${s.result}`),
    ``,
    `### Failing criteria (${failing.length})`,
    ...failing.map((c) => `- **${c.criterionId}**: ${c.feedback ?? "(no feedback)"}`),
  ];
  return applyLineCap(lines.join("\n"), 300);
}
```

---

### `src/orchestrator/checkpoints/renderers/code-review.ts` (create) — s11-c8

**Artifact shape:** No sample exists on disk yet (`.bober/reviews/` is empty), but the `ReviewResult` interface is defined at `src/orchestrator/code-reviewer-agent.ts:27-37`:
```ts
export interface ReviewResult {
  reviewId: string;
  contractId: string;
  specId: string;
  timestamp: string;
  summary: string;
  critical: ReviewFinding[];
  important: ReviewFinding[];
  minor: ReviewFinding[];
  approvedAreas: string[];
}
export interface ReviewFinding {
  description: string;
  evidence: Array<{ path: string; line: number; snippet: string }>;
  antiPattern?: string;
  source?: string;
}
```

**What to show (s11-c8):**
- `summary`
- `critical.length` + first 5 (with `evidence[0].path:line`)
- `important.length`
- `minor.length`
- `approvedAreas[]`

**Cap:** <300 lines. Per AGENTS.md, **every finding must cite file:line** — so the renderer must surface `evidence[0]` in the first 5 critical bullets.

---

### `src/orchestrator/checkpoints/renderers/sprint-summary.ts` (create)

**Artifact shape:** The `post-sprint` checkpoint passes `{ contract, evaluation, generatorResult }` (per `sites.ts:67-71` and `pipeline.ts:390`). Recommended type tag: `{ type: "sprint-summary", contract, evaluation, generatorResult }`. Fields to surface:
- `contract.contractId`, `contract.title`
- `evaluation.passed` / `overallResult`
- `evaluation.passedOnIteration`
- `generatorResult.filesChanged.length` + list
- `generatorResult.commit`

---

### `src/orchestrator/checkpoints/renderers/pipeline-summary.ts` (create)

**Artifact shape:** The `end-of-pipeline` checkpoint passes `{ success, completedSprints, failedSprints, duration, spec }` (per `sites.ts:73-76` and `pipeline.ts:713`). Recommended type tag: `{ type: "pipeline-summary", ...PipelineResult }`. Fields:
- `success`
- `completedSprints.length`
- `failedSprints.length`
- `duration` (ms → formatted)
- `spec.title`

---

### `src/orchestrator/checkpoints/mechanisms/cli.ts` (modify) — s11-c9

**Current (lines 36-80):** Inline `renderArtifact(checkpoint, artifact)` function (40 lines of generic "first 40 lines" logic).

**Replace with:**
```ts
import { render } from "../renderers/registry.js";

// At the call site (line 162):
const summary = `[Checkpoint: ${checkpoint}] Artifact ready.\n${render(artifact)}`;
process.stderr.write(`${summary}\n`);
```

**Keep:** the header line `[Checkpoint: ${checkpoint}] Artifact ready.` — that is mechanism-level framing, not artifact rendering.
**Delete:** the entire `renderArtifact` function body (lines 36-80).
**Imports:** remove unused branch (keep readline, child_process, etc.). Add `import { render } from "../renderers/registry.js";`.

---

### `src/orchestrator/checkpoints/mechanisms/disk.ts` (modify) — s11-c9

**Current (lines 36-56):** `ArtifactSummary` interface + `summarizeArtifact()` whitelisting 4 fields (`type`, `path`, `summary`, `lines`). Written to pending JSON at line 101.

**Replace with:** the pending JSON file's `artifact` field stays a small object, but ADD a `prompt` field (or rename to `summary`) holding the RENDERED MARKDOWN STRING. Per the sprint instructions:
> "the pending JSON file should store the RENDERED markdown string as `prompt` field (or similar) instead of the 4-field whitelist."

The pending JSON currently is:
```json
{ "checkpointId": "...", "runId": "...", "artifact": { "type": "...", "path": "...", "summary": "...", "lines": N }, "prompt": "Checkpoint \"X\" awaiting approval.", "requestedAt": "...", "timeoutAt": "..." }
```

After Sprint 11:
```json
{ "checkpointId": "...", "runId": "...", "artifact": { "type": "..." }, "prompt": "<RENDERED MARKDOWN>", "requestedAt": "...", "timeoutAt": "..." }
```

I.e., promote `render(artifact)` into the `prompt` field (or a new `renderedSummary` field — confirm convention by reading what `bober list-approvals` CLI displays; per the contract's intent, **the user sees this string when running `bober list-approvals`**).

**Keep the 100ms perf budget** (s9-c6). The 5MB-fullContent test in `disk.test.ts:263-299` MUST still pass — verify the renderer does not stringify large blobs. The renderers don't read I/O on the inline artifact; they look at the `type` + structured fields.

**Delete:** `summarizeArtifact()` and `ArtifactSummary` interface (lines 36-56).

**Update test:** `disk.test.ts:289-294` asserts on `parsed.artifact["type"]` and `parsed.artifact["summary"]`. Update to assert on `parsed.prompt` containing rendered markdown (e.g., a header line). The 5MB-fullContent guard remains valid — assert the rendered prompt does not contain `"aaaaa"`.

---

### `src/orchestrator/checkpoints/mechanisms/pr.ts` (modify) — s11-c9

**Current (lines 381-408):** `renderCheckpointComment(checkpoint, artifact)` instance method (28 lines manually formatting Type/Path/Summary).

**Replace with:**
```ts
import { render } from "../renderers/registry.js";

// In the instance method (or inline at line 231 call-site):
private renderCheckpointComment(checkpoint: CheckpointId, artifact: CheckpointArtifact): string {
  return [
    `## Checkpoint: \`${checkpoint}\``,
    ``,
    render(artifact),
    ``,
    `---`,
    ``,
    `Reply with \`approve ${checkpoint}\`, \`reject ${checkpoint} <reason>\`, or \`edit ${checkpoint}\n\`\`\`\n<new content>\n\`\`\`\`.`,
  ].join("\n");
}
```

**Keep:** the header `## Checkpoint: \`${checkpoint}\`` and the trailing "Reply with..." footer — those are PR-comment framing (per `s10-c2` PR-native signal docs), NOT artifact rendering.

**Update test:** `pr.test.ts` should already exercise `renderCheckpointComment` indirectly through `prComment` mock-arg inspection. Update assertions to expect the rendered markdown (e.g., a `## Research:` header when artifact.type === "research").

---

## 2. Patterns to Follow

### Registry pattern — module-level `Map` + self-registration
**Source:** `src/orchestrator/checkpoints/registry.ts:18-73`
```ts
const mechanisms = new Map<string, CheckpointMechanism>();
export function registerCheckpointMechanism(name: string, impl: CheckpointMechanism): void {
  mechanisms.set(name, impl);
}
export function getCheckpointMechanism(name: string): CheckpointMechanism {
  const impl = mechanisms.get(name);
  if (!impl) throw new Error(`Unknown checkpoint mechanism: ${name}. Registered: ${[...mechanisms.keys()].join(", ") || "(none)"}`);
  return impl;
}
// Self-register at module init.
registerCheckpointMechanism("noop", new NoopCheckpointMechanism());
registerCheckpointMechanism("cli", new CliCheckpointMechanism());
```
**Rule:** Module-level `Map` keyed by string; no class wrapper; self-register at module load. For renderers, the simpler `new Map([[...], [...]])` initializer is enough (no `register()` lifecycle needed since all 9 renderers ship in the same package).

### Mockable seam for external tools
**Source:** `src/orchestrator/checkpoints/mechanisms/pr.ts:29-44`
```ts
export interface GhClient {
  version(): Promise<{ ok: boolean; stdout: string }>;
  authStatus(): Promise<{ ok: boolean; stderr: string }>;
  // ...
}
export function createGhClient(cwd: string): GhClient {
  return { async version() { const r = await execa("gh", ["--version"], { reject: false, timeout: 5000 }); return { ok: r.exitCode === 0, stdout: r.stdout ?? "" }; }, ... };
}
```
**Rule:** Wrap every external-tool call (git, gh) in a small interface + factory; tests inject a fake; production uses the factory. Apply to `generator-diff.ts`: define a `GitClient` interface and `createGitClient(cwd)` factory.

### File header docstring with sprint citation
**Source:** `src/orchestrator/checkpoints/mechanisms/disk.ts:1-11`, `cli.ts:1-15`, `pr.ts:1-12`
```ts
/**
 * <One-line description>.
 *
 * <Detailed multi-line description.>
 *
 * Sprint <N> — <colocation/depend note>.
 */
```
**Rule:** Every new file starts with this block. Cite the sprint number (`Sprint 11`) and the colocated-in convention.

### Truncation marker convention (s11-c3 to c8)
**Source:** `generatorNotes` (sprint contract):
```
... <N more lines truncated, see <path>:<startLine> for full content>
```
**Rule:** This marker text is LOAD-BEARING — `evaluatorNotes`: "Verify the truncation marker is CONSISTENT across renderers (the format above)." Centralize it in a `renderers/_util.ts` helper:
```ts
export function applyLineCap(content: string, maxLines: number, sourcePath?: string): string {
  const lines = content.split("\n");
  if (lines.length <= maxLines) return content;
  const kept = lines.slice(0, maxLines);
  const dropped = lines.length - maxLines;
  const pathHint = sourcePath ? ` see ${sourcePath}:${maxLines + 1} for full content` : "";
  kept.push(`... <${dropped} more lines truncated,${pathHint}>`);
  return kept.join("\n");
}
```

### Markdown output (NOT plain text, NOT JSON)
**Source:** `pr.ts:381-408` (current `renderCheckpointComment`), uses `## Checkpoint:`, `**Type:**`, `**Path:**` — markdown structure.
**Rule:** Every renderer returns markdown — `evaluatorNotes`: "Verify each renderer's output is markdown (not plain text or JSON) — checkpoint mechanisms display markdown."

### Heavy artifact handling — read fields, don't stringify
**Source:** `src/orchestrator/checkpoints/mechanisms/disk.ts:47-56`
```ts
function summarizeArtifact(artifact: CheckpointArtifact): ArtifactSummary {
  const a = artifact as Record<string, unknown> | null | undefined;
  if (!a || typeof a !== "object") return {};
  const out: ArtifactSummary = {};
  if (typeof a["type"] === "string") out.type = a["type"];
  ...
}
```
**Rule:** Pick specific fields. Never `JSON.stringify(wholeArtifact)` — the disk-test 5MB-fullContent regression proves this matters (`disk.test.ts:263-299`).

### Colocated tests
**Source:** `src/orchestrator/checkpoints/mechanisms/disk.test.ts:1-16`
```ts
/**
 * Colocated unit tests for DiskCheckpointMechanism.
 *
 * Placed at src/orchestrator/checkpoints/mechanisms/disk.test.ts per the
 * COLOCATION HARD CONSTRAINT in Sprint 9 briefing — NOT in tests/orchestrator/.
 * This preserves the colocated:separate test ratio (colocated >= separate).
 */
```
**Rule:** Tests sit next to source. Add header note citing Sprint 11 + previous sprints' colocation precedent.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `readJson<T>` | `src/utils/fs.ts:24` | `(path: string): Promise<T>` | Read+parse a JSON file. Use IF you ever read artifact from `path` (but renderers should be pure — prefer to receive parsed objects). |
| `fileExists` | `src/utils/fs.ts:10` | `(path: string): Promise<boolean>` | Async fs.access wrapper. |
| `getDiff` | `src/utils/git.ts:64` | `(cwd, since?): Promise<string>` | Returns `git diff <ref>` stdout. **Use for `generator-diff.ts`** — wraps execa already. |
| `getChangedFiles` | `src/utils/git.ts:45` | `(cwd, since?): Promise<string[]>` | Returns `git diff --name-only` list. **Use for `generator-diff.ts`** to populate "files changed". |
| `getCurrentBranch` | `src/utils/git.ts:8` | `(cwd): Promise<string>` | `git rev-parse --abbrev-ref HEAD`. |
| `logger` | `src/utils/logger.ts` | `Logger` class | Centralized logging — but renderers are pure; do not log inside renderers (use `process.stderr.write` only in the registry fallback). |
| `applyLineCap` | **does not exist** — **create** in `renderers/_util.ts` | `(content, max, path?): string` | New helper for the truncation marker. |
| `EvalResultSchema`, `EvalResult` | `src/contracts/eval-result.ts:60-76` | zod schema + type | Type-only import for `eval-result.ts` renderer. |
| `SprintContractSchema`, `SprintContract` | `src/contracts/sprint-contract.ts:82-134` | zod schema + type | Type-only import for `sprint-contract.ts` renderer. |
| `PlanSpec`, `PlanSpecSchema` | `src/contracts/spec.ts:124-170` | zod schema + type | Type-only import for `plan.ts` renderer. |
| `ReviewResult`, `ReviewFinding` | `src/orchestrator/code-reviewer-agent.ts:17-37` | interface | Type-only import for `code-review.ts` renderer. |
| `render` (mechanisms-side dispatcher) | **does not exist** — **create** in `renderers/registry.ts` | `(artifact: unknown): string` | New dispatch entry point. |
| `renderArtifact` (cli.ts) | `src/orchestrator/checkpoints/mechanisms/cli.ts:39-80` | `(checkpoint, artifact): string` | **DELETE** — replaced by `render(artifact)`. |
| `summarizeArtifact` (disk.ts) | `src/orchestrator/checkpoints/mechanisms/disk.ts:47-56` | `(artifact): ArtifactSummary` | **DELETE** — replaced by `render(artifact)` into `prompt` field. |
| `renderCheckpointComment` (pr.ts, instance method) | `src/orchestrator/checkpoints/mechanisms/pr.ts:381-408` | `(checkpoint, artifact): string` | **SHRINK** — keep mechanism framing (`## Checkpoint: id`, reply footer); body becomes `render(artifact)`. |
| `formatFeedback` | `src/contracts/eval-result.ts:125-168` | `(SprintEvaluation): string` | Existing eval feedback formatter — output is plain text, NOT markdown. Don't reuse directly, but its structure is informative for `eval-result.ts`. |

---

## 4. Prior Sprint Output

### Sprint 7 — Checkpoint types/registry/noop
**Created:** `src/orchestrator/checkpoints/{types,registry,noop,sites,index}.ts` — exports `CheckpointMechanism`, `CheckpointArtifact = unknown`, `CheckpointOutcome`, `CheckpointId`, `getCheckpointMechanism`, `registerCheckpointMechanism`.
**Connection:** `CheckpointArtifact` is `unknown`; this sprint disambiguates via a runtime `type` field on each artifact shape. Don't change `CheckpointArtifact` to a discriminated union here (that's Sprint 12+).

### Sprint 8 — CLI mechanism
**Created:** `src/orchestrator/checkpoints/mechanisms/cli.ts` + colocated test. Inlined `renderArtifact(checkpoint, artifact)` at lines 39-80 (generic "first 40 lines" logic).
**Connection:** Sprint 11 deletes the inlined renderer and inserts `render(artifact)` from the new registry.

### Sprint 9 — Disk mechanism
**Created:** `src/orchestrator/checkpoints/mechanisms/disk.ts` + colocated test. Inlined `summarizeArtifact(artifact)` at lines 47-56 (4-field whitelist: type/path/summary/lines).
**Connection:** Sprint 11 deletes `summarizeArtifact` and stores `render(artifact)` markdown in the `prompt` field of the pending JSON.

### Sprint 10 — PR mechanism
**Created:** `src/orchestrator/checkpoints/mechanisms/pr.ts` + colocated test. Has instance method `renderCheckpointComment(checkpoint, artifact)` at lines 381-408 (manual "Type/Path/Summary" markdown). Also has `renderPrBody(runId, featureName)` at line 343-378 (checkbox-list — KEEP, unrelated to artifact rendering).
**Connection:** Sprint 11 shrinks `renderCheckpointComment` to delegate to `render(artifact)` but keeps the PR-comment framing (header + reply footer).

---

## 5. Relevant Documentation

### Project Principles
**No `.bober/principles.md` file exists.** Project conventions live in:
- `AGENTS.md` (lines 1–148) — contributor guidelines; key points for this sprint:
  - **Line 17:** "Confirm every file you touched is listed in the sprint contract's `expectedChanges`. If you modified a file not in `expectedChanges`, that is a scope violation."
  - **Line 49:** "Generators that modify files not listed in the sprint contract's `expectedChanges`. Scope creep is a contract violation, not a feature."
  - **Line 57:** "Review findings must cite `file:line`" — applies to `code-review.ts` renderer (must surface evidence[0].path:line).
  - **Line 65:** "PRs that soften `EXTREMELY-IMPORTANT` ... require eval evidence" — irrelevant for code, but stays in artifact rendering: if rendering an agent prompt, preserve the verbatim voice.
- `.bober/anti-patterns/README.md` (and 4 doc files) — quality reference.

### Architecture Decisions
**No `.bober/architecture/` directory.** The closest equivalents are:
- `src/orchestrator/checkpoints/sites.ts` (lines 23-78) — 9 checkpoint sites + which artifact each surfaces. **Source of truth** for what `artifact.type` should be per checkpoint:
  - `post-research` → `researchDoc: ResearchDoc` → `type: "research"`
  - `post-plan` → `spec: PlanSpec` → `type: "plan-spec"`
  - `post-sprint-contract` → `contracts: SprintContract[]` → `type: "sprint-contract"` (array — renderer can show first 3)
  - `pre-curator` → `{ contract, spec, completedContracts }` → no perfect match; treat as `type: "curator-briefing"` ONLY when the briefing artifact is passed (Sprint 12+ wires this) — for now, this site surfaces context, not a briefing. Renderer must tolerate missing inputs.
  - `pre-generator` → `{ contract, iteration, handoff }` → `type: "sprint-contract"` for the contract slice
  - `pre-evaluator`, `post-sprint` → `{ contract, evaluation, generatorResult }` → `type: "sprint-summary"` or `"eval-result"` depending on which slice the mechanism is asked to render
  - `pre-code-reviewer` → `{ contract, evaluation }` → `type: "eval-result"` (the evaluation slice)
  - `end-of-pipeline` → `PipelineResult` → `type: "pipeline-summary"`

### Other Docs
- `package.json:11-17` — `test` script is `vitest`. `typecheck` is `tsc --noEmit`. `lint` is `eslint src/`.
- `tsconfig.json` (assumed strict; all imports use `.js` extension per ESM convention — confirmed by every existing file in `src/`).

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/orchestrator/checkpoints/mechanisms/disk.test.ts:1-40`
```ts
/**
 * Colocated unit tests for DiskCheckpointMechanism.
 *
 * Placed at src/orchestrator/checkpoints/mechanisms/disk.test.ts per the
 * COLOCATION HARD CONSTRAINT in Sprint 9 briefing — NOT in tests/orchestrator/.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiskCheckpointMechanism } from "./disk.js";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-disk-cp-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });

describe("DiskCheckpointMechanism — approve flow (s9-c7a)", () => {
  it("returns { approved: true } when .approved.json appears", async () => {
    const m = new DiskCheckpointMechanism(tmpDir, { pollMs: 10 });
    // ...
    const outcome = await m.request(id, { type: "research-doc", path: ".bober/research/x.md" });
    expect(outcome).toEqual({ approved: true });
  });
});
```

**Runner:** `vitest`
**Assertion style:** `expect(x).toEqual(...)`, `expect(x).toContain(...)`, `expect(x).toMatch(/.../)`, `expect(x).toBeLessThan(n)`
**Mock approach:** `vi.mock("node:fs/promises", () => ({...}))` for module-level mocks; **prefer dependency injection over `vi.mock`** for renderers (factory functions accept the seam). See `pr.test.ts:41-59` (`buildGhStub`).
**File naming:** `<source>.test.ts` co-located with `<source>.ts`
**Location:** **co-located** — `src/orchestrator/checkpoints/renderers/<name>.test.ts` (NOT `tests/orchestrator/...`)

### Recommended test structure for each renderer
```ts
import { describe, it, expect } from "vitest";
import { renderResearch } from "./research.js";

describe("renderResearch (s11-c3)", () => {
  it("extracts title from H1", () => {
    const out = renderResearch({ type: "research", content: "# My Research\n\nbody" });
    expect(out).toContain("## Research: My Research");
  });

  it("returns markdown (not JSON, not plain text)", () => {
    const out = renderResearch({ type: "research", content: "# X" });
    expect(out).toMatch(/^##\s/m); // markdown header
    expect(out).not.toMatch(/^\s*\{/); // not JSON
  });

  it("caps at 500 lines with truncation marker", () => {
    const huge = "# X\n" + "line\n".repeat(1000);
    const out = renderResearch({ type: "research", content: huge, path: "/x.md" });
    expect(out.split("\n").length).toBeLessThanOrEqual(501);
    expect(out).toMatch(/<\d+ more lines truncated, see \/x\.md:/);
  });
});
```

### Registry test
```ts
describe("render registry (s11-c2)", () => {
  it("dispatches by artifact.type", () => {
    const out = render({ type: "plan-spec", title: "X", features: [], assumptions: [], outOfScope: [] });
    expect(out).toContain("## Plan: X");
  });

  it("falls back to generic JSON + stderr warning for unknown type", () => {
    const warns: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((s) => { warns.push(String(s)); return true; });
    const out = render({ type: "nonsense", x: 1 });
    expect(out).toMatch(/```json/);
    expect(warns.join("")).toMatch(/no entry for artifact\.type=/);
    spy.mockRestore();
  });
});
```

### E2E Test Pattern
**Not applicable.** No Playwright config in this repo. Renderers are unit-tested only.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/checkpoints/mechanisms/cli.test.ts` (lines 65-67, 73) | `cli.ts:renderArtifact()` semantics | **medium** | Tests inject artifacts like `{ path: "x.md", text: "hello world" }` — after the change, render() will treat these as `unknown type` → generic fallback (markdown JSON dump). Update tests or add `type: "research"` to fixtures. |
| `src/orchestrator/checkpoints/mechanisms/disk.test.ts:289-294` | `disk.ts:summarizeArtifact()` output shape | **high** | Asserts `parsed.artifact["type"]` and `parsed.artifact["summary"]`. After Sprint 11, the rendered output lives in `parsed.prompt`. Update assertions: `expect(parsed.prompt).toContain("## ")`. The 5MB-leak check (`not.toContain("aaaaa")`) STILL applies — assert on `parsed.prompt`. |
| `src/orchestrator/checkpoints/mechanisms/pr.test.ts` | `pr.ts:renderCheckpointComment` body | **medium** | Tests inspect `prComment` mock-arg for body content (e.g., `"Type:"`, `"Path:"` text). Update to expect new rendered markdown headers (`"## Research:"` etc.). |
| `src/orchestrator/pipeline.ts:140,235,298,355,390,485,621,651,713` | `getCheckpointMechanism("noop").request(id, artifact)` | **low** | Noop mechanism ignores artifact entirely; pipeline call-sites unaffected. But **if any call-site does NOT pass `type` on the artifact**, future careful-flow runs will hit the generic fallback. Audit each site — recommend adding `type` literal to each artifact (out of scope per s11 — Sprint 12 wires careful-flow). |
| `src/orchestrator/checkpoints/checkpoints.test.ts` | Registry behavior | **low** | Read this file (not opened in this briefing); update if it asserts on inline-render output. |

### Existing Tests That Must Still Pass
Run `npm run test` and verify NO regressions in these files:
- `src/orchestrator/checkpoints/mechanisms/cli.test.ts` (5 describe blocks, 6 tests) — update fixtures to include `type` OR accept generic-fallback output.
- `src/orchestrator/checkpoints/mechanisms/disk.test.ts` (7 describe blocks, ~11 tests) — **REQUIRED UPDATE** at lines 289-294 (5MB-leak assertion needs to read from `parsed.prompt`, not `parsed.artifact.summary`).
- `src/orchestrator/checkpoints/mechanisms/pr.test.ts` (30 tests per eval-10) — update comment-body assertions.
- `src/orchestrator/checkpoints/checkpoints.test.ts` — verify still green.
- All other `src/**/*.test.ts` (667 tests total per eval-10) — should be unaffected; renderers are new code.

### Features That Could Be Affected
- **feat-2 Tier 2 careful-flow** — this sprint IS part of feat-2 (sprint 5/8). Sprints 12 (feedback propagation) and 13 (audit hooks) will read what these renderers produce. The `prompt` field stored in the pending JSON is read by the `bober list-approvals` CLI (added in Sprint 9). Verify `bober list-approvals` still displays sensible output after the change.
- **Sprint 14 (config wiring)** — `getCheckpointMechanismFor(checkpointId, config)` already exists. No impact.
- **CLI commands `bober approve/reject/list-approvals`** at `src/cli/commands/{approve,reject,list-approvals}.ts` — these read the pending JSON. If they read `artifact.summary`, they'll need updating. **Check `src/cli/commands/list-approvals.ts` for `parsed.artifact.summary` references** before changing the disk pending shape.

### Recommended Regression Checks
After implementation, the Generator MUST run and verify exit 0:
1. `npm run typecheck` — ensures Zod schema imports + type-only imports resolve.
2. `npm run lint` — ESLint on `src/`.
3. `npm run build` — `tsc` emits to `dist/`.
4. `npm run test` — vitest must report `0 failed`. Per eval-10, baseline was 663 passed / 4 skipped / 0 failed. Sprint 11 adds 9 renderer test files (~30 tests). New baseline ~693 passed.
5. **Spot-check `disk.test.ts:289-294`** — the 5MB-leak guard MUST still pass against the new `prompt` field shape.
6. **Spot-check `cli.test.ts:83-99` (approve branch)** — fixture is `{ path: "x.md", text: "hello world" }`; after change, this hits generic fallback. Either add `type: "research"` to the fixture OR accept the JSON-dump output in the assertion (current assertion is only on `outcome`, not stderr-rendered string, so likely passes unchanged — but verify).
7. Manually invoke `node dist/cli/index.js list-approvals` after a synthetic disk pending file to confirm the rendered prompt is human-readable.

---

## 8. Implementation Sequence

1. **`src/orchestrator/checkpoints/renderers/_util.ts`** — create the shared `applyLineCap(content, maxLines, path?)` helper + any other tiny helpers (e.g., `extractH1`, `firstNNonBlank`). Tiny — 30–60 lines.
   - Verify: file compiles standalone; no imports from other renderers.

2. **`renderers/research.ts`** — first markdown-source renderer. Defines the `extractContent` pattern (handle both `{ content }` inline and `{ path }` for file-on-disk — but skip the file read for purity; document that mechanisms should preload content).
   - Verify: write `research.test.ts` colocated, assert markdown headers + cap.

3. **`renderers/plan.ts`, `renderers/sprint-contract.ts`, `renderers/eval-result.ts`** — three JSON-source renderers (no file reads). Type-only imports from `src/contracts/*`.
   - Verify: each has 2-3 unit tests (happy path + cap).

4. **`renderers/curator-briefing.ts`** — another markdown-source renderer. Uses `_util.ts` helpers.
   - Verify: extracts H1 and `## 0. Sprint Summary` body.

5. **`renderers/sprint-summary.ts`, `renderers/pipeline-summary.ts`** — two compound-artifact renderers (mixes contract + evaluation + generator-result).
   - Verify: handle missing sub-fields gracefully.

6. **`renderers/code-review.ts`** — JSON-source renderer reading `ReviewResult` shape from `src/orchestrator/code-reviewer-agent.ts:27-37`.
   - Verify: surfaces `evidence[0].path:line` in first 5 critical bullets (per AGENTS.md:71).

7. **`renderers/generator-diff.ts`** — the one allowed-I/O renderer. Define `GitClient` interface + `createGitClient(cwd)` factory mirroring `pr.ts:GhClient`. Use `src/utils/git.ts` helpers OR direct execa.
   - Verify: binary-file skip works (use a fixture with `numstat: "-\t-\tfile.bin"`); 50-line per-file truncation works.

8. **`renderers/registry.ts`** — wire everything together. Single `render(artifact)` export. Generic fallback + stderr warning.
   - Verify: dispatch table maps all 9 types; unknown type test passes.

9. **`renderers/registry.test.ts`** — colocated; tests dispatch + fallback.
   - Verify: vitest finds it; covers `s11-c2`.

10. **Modify `mechanisms/cli.ts`** — delete lines 36-80 (`renderArtifact`); add `import { render } from "../renderers/registry.js";`; at line 162, call `render(artifact)` after the header line.
    - Verify: `cli.test.ts` still passes (or update fixtures to add `type`).

11. **Modify `mechanisms/disk.ts`** — delete lines 36-56 (`summarizeArtifact` + `ArtifactSummary`); at line 101 (pending object), set `prompt: render(artifact)` and shrink `artifact: { type: a?.type }` to a 1-field stub.
    - Verify: `disk.test.ts:289-294` updated to assert on `parsed.prompt`; 5MB-leak guard still passes.

12. **Modify `mechanisms/pr.ts`** — shrink `renderCheckpointComment` (lines 381-408) to delegate to `render(artifact)` while preserving the `## Checkpoint: id` header and reply footer.
    - Verify: `pr.test.ts` comment-body assertions updated.

13. **Run full verification** — `npm run typecheck && npm run lint && npm run build && npm run test` — assert exit 0; ~693 tests passing.

14. **Spot-check `src/cli/commands/list-approvals.ts`** — if it reads `parsed.artifact.summary`, update to read `parsed.prompt`. (Out of scope per `expectedChanges`, but fix-in-place if it breaks; if it's a separate touch, flag it in the generator handoff `blockers`.)

---

## 9. Pitfalls & Warnings

- **DO NOT** create a `tests/orchestrator/checkpoints/renderers/` directory. Colocate at `src/orchestrator/checkpoints/renderers/<name>.test.ts`. The contract's `expectedChanges` is WRONG on this point; Sprint 5 scanner enforces `colocated >= separate`. (See Sprint 8, 9, 10 briefings — all flagged the same correction.)

- **DO NOT** put any `await readFile()` inside the 8 pure renderers (research/plan/sprint-contract/curator-briefing/eval-result/code-review/sprint-summary/pipeline-summary). The mechanism is responsible for preloading file content into the artifact's `content` field. The only renderer that may shell out is `generator-diff.ts` (`git diff`).

- **DO NOT** import any renderer from a mechanism file other than via `registry.ts`. The dispatch point is single — never `cli.ts` → `renderResearch` direct import.

- **DO NOT** stringify the entire artifact in any renderer (the `disk.test.ts:289-294` 5MB-leak guard catches this — and Sprint 9 chose the 4-field whitelist specifically to fail-fast on big blobs).

- **DO NOT** change the `CheckpointArtifact = unknown` type in `types.ts`. The contract says renderers are loosely typed against this; tightening it is Sprint 12+'s job.

- **DO NOT** add `type` field requirements to existing pipeline call-sites in `pipeline.ts` — that's Sprint 12+'s job. For now, the artifacts at those call-sites lack `type` → they hit the generic fallback. That is ACCEPTABLE per s11-c2 ("Falls back to generic text dump for unknown types with warning"). The artifact types are documented in `sites.ts` for the future wiring.

- **TRUNCATION MARKER MUST MATCH EXACTLY:** `... <N more lines truncated, see <path>:<startLine> for full content>`. Evaluator explicitly checks consistency across renderers. Centralize it in `_util.ts:applyLineCap` so there's exactly one source of truth.

- **OUTPUT MUST BE MARKDOWN.** Not JSON. Not plain text. Headers (`##`), bold (`**...**`), bullets (`-`), code fences for code/JSON. The generic fallback DOES wrap JSON in a `\`\`\`json` fence — that's still markdown.

- **Line caps are MAXIMUMS not targets.** Per `evaluatorNotes`: "A 50-line render for a small artifact is correct. A 500-line render for a small artifact is over-rendering."

- **Avoid duplication thresholds.** Per `evaluatorNotes`: "if every renderer reimplements 'read frontmatter from markdown', factor to a shared util. But don't over-abstract — three renderers sharing a utility is fine; one renderer using its own logic is fine."

- **Test fixtures must include `type` field** when testing through the registry dispatch. When testing a single renderer directly (e.g., `renderResearch(artifact)`), the `type` field is not consulted by the renderer itself — but is required by the dispatch test.

- **Markdown in PR comments has a 65KB cap.** Per `generatorNotes`: GitHub PR comment body limit is 65,536 bytes. The 200–500 line per-renderer caps prevent this. Don't override the caps.

- **The `renderArtifact` function in `cli.ts:39-80` returns a string starting with `[Checkpoint: ${checkpoint}] Artifact ready.\n`.** That header is mechanism-level (CLI-specific framing), NOT artifact-level. Preserve it OUTSIDE the registry call — the new code is `[Checkpoint: ${checkpoint}] Artifact ready.\n${render(artifact)}`.

- **The `pr.ts:renderCheckpointComment` returns a string ending with a "Reply with `approve <id>` ..." footer.** That footer is PR-mechanism-specific (instructs the human how to respond on GitHub). Preserve it OUTSIDE the registry call. Renderers do NOT know about mechanism-specific affordances.

- **`disk.ts` pending JSON shape change is a wire-format change.** The `bober approve`, `bober reject`, `bober list-approvals` CLI commands (Sprint 9) read this file. If any of them parse the `artifact` field expecting `summary`/`lines`, they need updating. Read `src/cli/commands/list-approvals.ts` and `src/cli/commands/approve.ts` before changing the shape — flag any cross-cut as a blocker in the generator handoff.

- **`renderGeneric` warning goes to stderr.** Tests must spy on `process.stderr.write` to assert it; don't write to `console.warn` (different stream, AGENTS.md observability convention).

- **Imports use `.js` extension (ESM).** Every import inside `renderers/` must end in `.js` (e.g., `import { applyLineCap } from "./_util.js";`). TypeScript strict mode + NodeNext.

- **The `_util.ts` prefix-underscore** signals "private to the directory" — common TypeScript convention. Don't re-export `_util.ts` from `registry.ts`. Renderers import from it directly.

- **Beware `JSON.stringify` returning `undefined`** for `unknown` values that aren't JSON-serializable (functions, symbols, circular). The generic fallback uses `?? String(artifact)` to handle this — keep that guard.

