# Sprint Briefing: Orchestrator-owned real-diff provider + wire into the audit (fixes G4), auditor stays read-only

**Contract:** sprint-spec-20260714-security-auditor-per-stack-skills-6
**Generated:** 2026-07-14T00:00:00Z

---

## 0. TL;DR for the Generator

Build `SecurityDiffProvider.compute(...)` in orchestrator Node that shells `git` the SAME never-throw way `security-scanners.ts` shells scanners (execa `reject:false` + `cancelSignal`), returns a bounded `AuditDiff`, and feeds real `changedPaths`/`diffKeywords` into the sprint-5 resolver + the finder prompt. It is OPT-IN via a new OPTIONAL `config.security.diff` object (default `mode:'estimated-files'` = today's exact behavior). The auditor toolset MUST stay read-only (still `curator` role — no bash/write/edit). `SecurityAuditDeps` does **not** exist yet — you introduce it this sprint as the injectable seam so tests never shell real git.

Six files, dependency-ordered: types+provider → its test → schema → schema test → auditor wiring → auditor test.

---

## 1. Target Files

### src/orchestrator/security-knowledge/diff-provider.ts (create)

**Directory pattern:** `src/orchestrator/security-knowledge/` uses kebab-case module names, one concern per file, with a co-located `*.test.ts` (see `ls`: `index.ts`, `parser.ts`, `registry.ts`, `resolver.ts`, `selector.ts`, `signature.ts`, each with a `.test.ts`). Types live at the top of the module that owns them (`signature.ts` holds `SecuritySignature`/`SecurityStackId`; `resolver.ts` holds `StackSecurityContext`).
**Most similar existing file:** `src/orchestrator/security-scanners.ts` — copy its injectable-runner + never-throw shape verbatim (see Pattern A). Also mirror `selector.ts` for "pure and total, never throws".

**Structure template (based on security-scanners.ts + resolver.ts):**
```ts
import { execa } from "execa";
import { logger } from "../../utils/logger.js";
import type { BoberConfig } from "../../config/schema.js";
import { getGraphState, getGraphDeps } from "../tools/index.js";

// ── AuditDiff data model (architecture: shared input for sprints 7/8) ──
export interface DiffHunk { startLine: number; lineCount: number; content: string; }
export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  hunks: DiffHunk[];
}
export interface AuditDiff {
  changedFiles: ChangedFile[];
  neighborhoodFiles: string[];
  truncated: boolean;
}

// ── Injectable git runner (keeps tests off real git — mirrors ScannerRunner) ──
export interface GitRunResult { exitCode: number | undefined; stdout: string; failed: boolean; }
export type GitRunner = (
  args: string[],
  opts: { cwd: string; signal: AbortSignal },
) => Promise<GitRunResult>;

const MAX_CHANGED_FILES = 60;
const MAX_HUNK_BYTES = 256 * 1024; // total across all hunks; exceed => truncated
const DIFF_CONTEXT_LINES = 3;      // git diff -U<n>

// default runner: EXACT execa options from security-scanners.ts:54 (never-throw)
const defaultGitRunner: GitRunner = async (args, opts) => { /* execa("git", args, {...}) */ };

export interface SecurityDiffProvider {
  compute(input: {
    projectRoot: string;
    baseRef?: string;
    expandWithGraph: boolean;
    signal: AbortSignal;
    config?: BoberConfig;       // needed for getGraphState(config) gate
    runner?: GitRunner;         // injected in tests
  }): Promise<AuditDiff>;
}

const EMPTY_DIFF: AuditDiff = { changedFiles: [], neighborhoodFiles: [], truncated: false };

export const securityDiffProvider: SecurityDiffProvider = {
  async compute(input) {
    try {
      // 1. resolve baseRef (default: merge-base w/ default branch, else HEAD~ fallback)
      // 2. git diff --name-status <baseRef>  -> ChangedFile.status
      // 3. git diff -U3 <baseRef>            -> parse unified diff into hunks
      // 4. cap changedFiles + hunk bytes -> truncated
      // 5. if expandWithGraph && getGraphState(config).engineHealth==='ready' -> graph neighbors
      // any failure / ENOENT / not-a-repo / abort -> return EMPTY_DIFF (NEVER throw)
    } catch { return EMPTY_DIFF; }
  },
};

// Pure helper (unit-testable without git): parse a unified diff string -> ChangedFile[]
export function parseUnifiedDiff(nameStatus: string, unified: string): { files: ChangedFile[]; truncated: boolean } { /* ... */ }

// Pure helper: tokenize changed hunk text -> diffKeywords (identifiers + notable substrings)
export function extractDiffKeywords(files: ChangedFile[]): string[] { /* ... */ }
```

---

### src/orchestrator/security-auditor-agent.ts (modify)

**Relevant section — current signature (lines 61-67):** add ONE trailing optional `deps` param so all existing positional callers stay byte-compatible.
```ts
export async function runSecurityAudit(
  contract: SprintContract,
  evaluation: EvaluationRunResult | null,
  projectRoot: string,
  config: BoberConfig,
  priors: SecurityFinding[] = [],
  // NEW (append last — see Impact Analysis for why last):
  // deps: SecurityAuditDeps = {},
): Promise<SecurityAuditResult> {
```

**Relevant section — THE sprint-6 seam (lines 92-102), quoted exactly as it stands today:**
```ts
  const knowledgeIndex = getSecurityKnowledgeIndex();
  await knowledgeIndex.load();
  const ctx = await resolveStackSecurityContext({
    stack: config.project.stack,
    // Sprint-6 seam: the git diff provider lands next sprint. For now the
    // finder's retrieved signatures are ranked against the sprint's
    // estimated-files scope rather than a real diff.
    changedPaths: contract.estimatedFiles,
    diffKeywords: [],
    index: knowledgeIndex,
  });
```
**What changes here:** compute the diff ONCE before this block, then feed it in:
```ts
  // NEW: compute the real diff once (opt-in; default keeps today's behavior)
  let changedPaths = contract.estimatedFiles;
  let diffKeywords: string[] = [];
  let auditDiff: AuditDiff | undefined;
  if (config.security?.diff?.mode === "git-diff") {
    const provider = deps.diffProvider ?? securityDiffProvider;
    const diffAbort = new AbortController();
    const diffTimer = setTimeout(() => diffAbort.abort(), config.security?.timeoutMs ?? 300_000);
    try {
      auditDiff = await provider.compute({
        projectRoot,
        baseRef: config.security.diff.baseRef,
        expandWithGraph: config.security.diff.expandWithGraph,
        signal: diffAbort.signal,
        config,
      });
    } finally {
      clearTimeout(diffTimer);
    }
    // Empty diff (no changes / failure) => fall back to estimatedFiles (no regression)
    const files = auditDiff.changedFiles.map((f) => f.path);
    if (files.length > 0) {
      changedPaths = files;
      diffKeywords = extractDiffKeywords(auditDiff.changedFiles);
    }
  }
  const ctx = await resolveStackSecurityContext({
    stack: config.project.stack,
    changedPaths,
    diffKeywords,
    index: knowledgeIndex,
  });
```
Then thread `auditDiff` into `buildUserMessage` so the finder prompt scopes to real changed files/hunks (add a new optional param + a rendered section, mirroring the `priorsSection` at lines 224-227).

**Relevant section — the AbortController/timeout precedent to COPY (lines 111-127), the scanner pre-filter seam:**
```ts
  const configuredScanners = config.security?.scanners ?? [];
  let effectivePriors = priors;
  if (configuredScanners.length > 0) {
    const scannerAbort = new AbortController();
    const scannerTimer = setTimeout(
      () => scannerAbort.abort(),
      config.security?.timeoutMs ?? 300_000,
    );
    try {
      const scannerPriors = await runScannerPreFilter({
        scanners: configuredScanners,
        projectRoot,
        signal: scannerAbort.signal,
      });
      effectivePriors = [...priors, ...scannerPriors];
    } finally {
      clearTimeout(scannerTimer);
    }
  }
```

**Relevant section — read-only tool resolution (lines 79-82) — DO NOT CHANGE:**
```ts
  const graphState = getGraphState(config);
  const graphDeps = graphState.engineHealth === "ready" ? getGraphDeps() : undefined;
  const toolSet = resolveRoleTools("curator", projectRoot, graphState, graphDeps ?? undefined);
  const systemPrompt = await assembleSystemPrompt("curator", "bober-security-auditor", projectRoot, graphState);
```
Git runs ONLY in the diff provider (orchestrator Node). The auditor keeps the `curator` role → still `read_file/glob/grep` only. `getGraphState`/`getGraphDeps` are already imported at line 10 — reuse them in the diff provider.

**`buildUserMessage` (lines 195-276):** add an optional `auditDiff?: AuditDiff` param and render a "# Changed files (real diff)" section (only when `auditDiff?.changedFiles.length`), following the exact `priorsSection` conditional-render idiom at lines 224-227. Also update the "You have Read/Grep/Glob only ... there is no diff available without Bash" prose at lines 252-257 to note that a real diff IS now provided inline when git-diff mode is on.

**Imports this file already has (reuse, don't re-add):** `getGraphState, getGraphDeps` from `./tools/index.js` (line 10); `logger` (line 18); `BoberConfig` (line 1).
**Imported by:** `src/orchestrator/security-gate.ts:25` (in-pipeline gate), `src/cli/commands/security-audit.ts:40` (standalone CLI), plus tests. Both call positionally — see Impact Analysis.
**Test file:** `src/orchestrator/security-auditor-agent.test.ts` (exists).

---

### src/config/schema.ts (modify)

**Relevant section — SecuritySectionSchema (lines 210-228):** add ONE optional field. Mirror the `budget: BudgetSectionSchema.optional()` idiom (line 221) — an OPTIONAL sub-object with NO outer default, so `parse({})` does NOT materialize a `diff` key (byte-identical, see the deep-equal test in §6).
```ts
export const SecuritySectionSchema = z.object({
  enabled: z.boolean().default(false),
  failClosed: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(300_000),
  model: ModelChoiceSchema.default("opus"),
  maxTurns: z.number().int().min(1).default(20),
  provider: z.string().optional(),
  endpoint: z.string().nullable().optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
  budget: BudgetSectionSchema.optional(),
  scanners: z.array(EvalStrategySchema).default([]),
  standaloneBlockOn: z.enum(["critical", "important"]).default("critical"),
  hub: z.boolean().default(true),
  // NEW — sprint 6. OPTIONAL: absent => byte-identical to today.
  diff: SecurityDiffConfigSchema.optional(),
});
```
Add above it:
```ts
export const SecurityDiffConfigSchema = z.object({
  mode: z.enum(["estimated-files", "git-diff"]).default("estimated-files"),
  baseRef: z.string().optional(),
  expandWithGraph: z.boolean().default(false),
});
export type SecurityDiffConfig = z.infer<typeof SecurityDiffConfigSchema>;
```
`security` is wired `.optional()` on the root config at line 633 (`security: SecuritySectionSchema.optional()`) — no change needed there.

**Test file:** `src/config/schema.test.ts` (exists).

---

## 2. Patterns to Follow

### Pattern A — Never-throw injectable subprocess runner (COPY EXACTLY)
**Source:** `src/orchestrator/security-scanners.ts`, lines 20-70
```ts
export interface ScannerRunResult { exitCode: number | undefined; stdout: string; failed: boolean; }
export type ScannerRunner = (
  cmd: string, args: string[], opts: { cwd: string; signal: AbortSignal },
) => Promise<ScannerRunResult>;

const MAX_SCANNER_BUFFER = 1024 * 1024 * 10;

const defaultRunner: ScannerRunner = async (cmd, args, opts) => {
  const result = await execa(cmd, args, {
    cwd: opts.cwd,
    cancelSignal: opts.signal,   // ties child lifetime to the audit AbortSignal
    killSignal: "SIGKILL",
    reject: false,               // ENOENT / nonzero exit resolves, never throws
    all: true,
    maxBuffer: MAX_SCANNER_BUFFER,
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  return { exitCode: result.exitCode, stdout: result.all ?? result.stdout ?? "", failed: result.failed };
};
```
**Rule:** The diff provider's `defaultGitRunner` uses these EXACT execa options (`cancelSignal: opts.signal`, `killSignal:"SIGKILL"`, `reject:false`, `maxBuffer`, `FORCE_COLOR:"0"`). Wrap every git call in try/catch as a defensive backstop too (belt-and-suspenders, per the comment at security-scanners.ts:29-35).

### Pattern B — Pure, total, never-throws (defensive narrowing)
**Source:** `src/orchestrator/security-knowledge/selector.ts`, lines 43-46
```ts
export function selectSignatures(input: SelectInput): SecuritySignature[] {
  const stackSignatures = Array.isArray(input.stackSignatures) ? input.stackSignatures : [];
  const genericFloor = Array.isArray(input.genericFloor) ? input.genericFloor : [];
  const topK = Number.isFinite(input.topK) ? Math.max(0, Math.trunc(input.topK)) : 0;
```
**Rule:** `parseUnifiedDiff` and `extractDiffKeywords` must be PURE and never throw — guard every array/field access, return `[]`/`EMPTY_DIFF` on any structural surprise. Same discipline as `parseSlitherOutput` (security-scanners.ts:144-201): "any structural mismatch returns [] rather than throwing".

### Pattern C — Isolated AbortController + setTimeout + finally clearTimeout
**Source:** `src/orchestrator/security-auditor-agent.ts`, lines 112-126 (quoted in §1)
**Rule:** Time-box `compute()` under its OWN AbortController keyed to `config.security?.timeoutMs ?? 300_000`, `clearTimeout` in `finally`. This is the exact shape the scanner pre-filter already uses one block below.

### Pattern D — Conditional prompt section (render only when present)
**Source:** `src/orchestrator/security-auditor-agent.ts`, lines 224-227
```ts
  const priorsSection =
    priors.length > 0
      ? `# Deterministic scanner findings (ground truth priors)\n\n${JSON.stringify(priors, null, 2)}\n\n`
      : "";
```
**Rule:** Render the changed-files/hunks section the same way — empty string when there is no diff, so git-diff-mode-with-no-changes produces a prompt byte-identical to estimated-files mode (no regression, sc-6-5).

### Pattern E — Existing git-via-execa precedent (for reference, but reject:false only)
**Source:** `src/utils/git.ts`, lines 45-74 (`getChangedFiles`, `getDiff`) and `src/discovery/scanners/git-conventions.ts`, lines 103-131.
```ts
// utils/git.ts:64-73
export async function getDiff(cwd: string, since?: string): Promise<string> {
  const ref = since ?? "HEAD";
  const { stdout } = await execa("git", ["diff", ref], { cwd, reject: false });
  return stdout;
}
```
**Rule:** These prove `git diff <ref>` / `git branch -a` via execa is the house style, BUT they use only `reject:false` (no `cancelSignal`, no `maxBuffer`). Do NOT reuse `getDiff` directly — the provider needs the fuller Pattern-A options (cancelSignal for abort, maxBuffer cap) plus `--name-status` and `-U<n>` variants. `utils/git.ts` has NO merge-base helper, so you implement baseRef resolution yourself.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `defaultRunner` / `ScannerRunner` | `src/orchestrator/security-scanners.ts:36,54` | `(cmd,args,{cwd,signal}) => Promise<ScannerRunResult>` | The execa never-throw runner template to mirror (do NOT export/reuse cross-module; copy the pattern into a `GitRunner`). |
| `getChangedFiles` | `src/utils/git.ts:45` | `(cwd, since?) => Promise<string[]>` | `git diff --name-only <ref>`; name-ONLY, no status/hunks — insufficient for AuditDiff but confirms the execa idiom. |
| `getDiff` | `src/utils/git.ts:64` | `(cwd, since?) => Promise<string>` | `git diff <ref>` full unified text; no cancelSignal/maxBuffer/-U control — reference only. |
| `getCurrentBranch` | `src/utils/git.ts:8` | `(cwd) => Promise<string>` | `git rev-parse --abbrev-ref HEAD`; may help baseRef fallback logic. |
| `getGraphState` | `src/orchestrator/tools/index.ts:130` | `(config?) => {graphEnabled, engineHealth}` | The graph readiness gate — call before touching the client (sc-6-2). |
| `getGraphDeps` | `src/orchestrator/tools/index.ts:148` | `() => {client, fallback} \| null` | Returns the GraphClient only when engine is 'ready', else null. |
| `GraphClient.impact` | `src/graph/client.ts:247` | `(target: NodeRef\|string) => Promise<GraphResult<ImpactReport>>` | The impact/neighbors call for graph neighborhood; returns `{ok:false,...}` on any failure (never throws). |
| `logger` | `src/utils/logger.ts` (imported at security-scanners.ts:6) | `logger.debug/info/warn(...)` | Structured logging; use `logger.debug` for degraded-git diagnostics (mirror security-scanners.ts:372). |
| `resolveStackSecurityContext` | `src/orchestrator/security-knowledge/resolver.ts:91` | `(input) => Promise<StackSecurityContext>` | Sprint-5 consumer of `changedPaths`/`diffKeywords` — you feed it the real values. |
| `selectSignatures` / `scoreSignature` | `src/orchestrator/security-knowledge/selector.ts:43,15` | pure | Shows exactly how `diffKeywords` (keyword-overlap, +2 each) and `changedPaths` (basename hints, +1) drive ranking — informs what your tokenizer should emit. |

Directories reviewed: `src/utils/` (git.ts, logger.ts — relevant), `src/orchestrator/security-knowledge/` (resolver/selector/index — relevant), `src/orchestrator/` (security-scanners.ts — the template). No `lib/`, `helpers/`, `shared/`, or `common/` directories exist in this repo.

---

## 4. Prior Sprint Output

### Sprint 5 (a081f35): registry + index + selector + resolver wired into runSecurityAudit
**Created / consumes:**
- `src/orchestrator/security-knowledge/resolver.ts` — exports `resolveStackSecurityContext(input)` and `ResolveStackSecurityContextInput` with fields `changedPaths: string[]` and `diffKeywords?: string[]` (resolver.ts:67-80). These are the two seams you populate.
- `src/orchestrator/security-knowledge/selector.ts` — `selectSignatures` ranks by `diffKeywords` overlap (+2 per matching `signature.keywords` entry, selector.ts:20-23) and `changedPaths` basename hints (+1, selector.ts:25-33).
**Connection to this sprint:** Today `runSecurityAudit` calls the resolver with `changedPaths: contract.estimatedFiles` and `diffKeywords: []` (security-auditor-agent.ts:99-100, explicitly commented "Sprint-6 seam"). You replace those two literals with values derived from the real `AuditDiff` when `config.security.diff.mode === 'git-diff'`.

**Note:** `SecurityAuditDeps` does NOT exist yet (grep of `src/` returns nothing). Sprint 5 did NOT add a `deps` param to `runSecurityAudit` — the current signature ends at `priors` (security-auditor-agent.ts:66). YOU introduce `SecurityAuditDeps { diffProvider?: SecurityDiffProvider }` this sprint and append it as the last param.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` at repo root for this check (the security specs live under `.bober/`). Governing conventions come from the contract's ADR references: **ADR-5 (orchestrator owns the diff; auditor never gets a git/Bash tool)** and **ADR-8 (graph-gated tool surface)**. `.bober/architecture/` exists (untracked) — the arch doc `arch-20260712-security-audit-agent-team` is the API-contract source cited by the auditor file header (security-auditor-agent.ts:41-45).

### Architecture Decisions relevant here
- **ADR-5:** the read-only-curator invariant. Git runs in orchestrator Node only. Enforced by keeping `resolveRoleTools("curator", ...)` unchanged (security-auditor-agent.ts:81) and guarded by the nonGoal tests (§6).
- **AuditDiff is the shared input** for sprint 7 (supply-chain) and sprint 8 (verifier) per contract nonGoals[0] — keep the type clean and exported.

### Other Docs
`config.security` is documented inline at schema.ts:200-209 as "opt-in and default-off ... a config that omits `security` entirely stays byte-identical (no defaults leak in)." Your `diff` field must uphold that same guarantee at the sub-field level.

---

## 6. Testing Patterns

### Unit Test Pattern — auditor agent (module-level vi.mock + injected fakes)
**Source:** `src/orchestrator/security-auditor-agent.test.ts`, lines 12-51, 113-121, 293
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
const loopSpy = vi.fn();
const clientSpy = vi.fn(() => ({}) as never);
vi.mock("./agentic-loop.js", () => ({ runAgenticLoop: loopSpy }));
vi.mock("../providers/factory.js", () => ({ createClient: clientSpy }));
vi.mock("./model-resolver.js", () => ({ resolveModel: () => "model-test" }));
vi.mock("./agent-loader.js", () => ({ assembleSystemPrompt: vi.fn().mockResolvedValue("SYS") }));
vi.mock("./security-scanners.js", () => ({ runScannerPreFilter: scannerPreFilterSpy }));
// Uses the REAL resolveRoleTools/ROLE_TOOLS; only stubs getGraphState/getGraphDeps to force ungated:
vi.mock("./tools/index.js", async () => {
  const actual = await vi.importActual<typeof ToolsIndexModule>("./tools/index.js");
  return { ...actual, getGraphState: () => ({ graphEnabled: false, engineHealth: "disabled" }), getGraphDeps: () => undefined };
});
const { runSecurityAudit } = await import("./security-auditor-agent.js");
// ... capture the outgoing prompt:
const userMessage = loopSpy.mock.calls[0][0].userMessage as string;
```
**Runner:** vitest. **Assertion style:** `expect`. **Mock approach:** `vi.mock` module factories + `vi.fn` spies; `await import(...)` AFTER the mocks. **File naming:** `<name>.test.ts` co-located. **Location:** co-located.

**sc-6-4 test (the key one):** inject a fake `diffProvider` via the new `deps` param whose `compute` resolves an `AuditDiff` containing a hunk with `'.raw('`; call `runSecurityAudit(contract, evaluation, root, config-with-git-diff, [], { diffProvider: fake })`; assert `loopSpy.mock.calls[0][0].userMessage` contains `.raw(` AND (using the REAL resolver, as this suite already does) that a matching signature is selected. Mirror the existing prompt-capture assertions at test lines 293-296 / 491-494.

### Unit Test Pattern — diff provider (inject a fake GitRunner; never shell real git)
Model `diff-provider.test.ts` on `security-scanners.test.ts` (injected `runner`) — you already have `ScannerPreFilterInput.runner` precedent (security-scanners.ts:316-317). Cases required by evaluatorNotes:
- fake runner returns a `--name-status` block + a unified diff → assert parsed `ChangedFile[]` + `DiffHunk[]` (sc-6-1).
- fake runner that throws / returns `{failed:true}` / ENOENT → assert `EMPTY_DIFF`, no throw (sc-6-1).
- oversized input (> `MAX_CHANGED_FILES` files or > `MAX_HUNK_BYTES`) → assert `truncated:true` (sc-6-1).
- graph: stub `getGraphState`→`{engineHealth:'ready'}` + a fake client `impact` returning `{ok:true, data:{affected:[...]}}` → `neighborhoodFiles` populated; stub not-ready and `{ok:false}` → `neighborhoodFiles:[]`, changedFiles still returned (sc-6-2).

### GraphResult / ImpactReport shapes to assert against
**Source:** `src/graph/types.ts`, lines 36-46, 59-77
```ts
export type GraphResult<T> =
  | { ok: true; data: T; backend: "mcp" | "binding"; durationMs: number; stale?: true }
  | { ok: false; reason: GraphFailureReason; detail: string };
export type NodeRef = { id: string; kind: "function"|"class"|"module"|"symbol"; file: string; line: number; symbol: string };
export type ImpactReport = { root: NodeRef; affected: NodeRef[]; testsAffected: NodeRef[] };
```
`GraphClient.impact` (client.ts:247) resolves `GraphResult<ImpactReport>` and NEVER throws (client.ts:4 "All methods return Promise<GraphResult<T>> and NEVER throw"). So graph neighborhood extraction is: for each changed path, resolve a NodeRef → `client.impact(...)` → if `res.ok`, collect `res.data.affected.map(n => n.file)` into `neighborhoodFiles`; on `!res.ok` skip. Gate the whole block on `getGraphState(config).engineHealth === 'ready'` (mirrors security-auditor-agent.ts:79-80).

### schema.test.ts convention — paired parse test
**Source:** `src/config/schema.test.ts`, lines 639-652 (the test you MUST NOT break)
```ts
describe("SecuritySectionSchema — standalone validation (sc-1-1)", () => {
  it("parses an empty object to the full documented default set", () => {
    const parsed = SecuritySectionSchema.parse({});
    expect(parsed).toEqual({
      enabled: false, failClosed: true, timeoutMs: 300_000, model: "opus",
      maxTurns: 20, scanners: [], standaloneBlockOn: "critical", hub: true,
    });   // <-- NOTE: no `diff` key. If you add diff with .optional() (no default), this stays green.
  });
```
**Add** (mirroring lines 654-682 round-trip style): a test that `parse({ diff: {} })` yields `diff: { mode: "estimated-files", expandWithGraph: false }`; that `parse({ diff: { mode: "git-diff", baseRef: "main", expandWithGraph: true } })` round-trips; and that `parse({})` STILL has no `diff` key (byte-identical). Also assert `parse({ diff: { mode: "bogus" } })` throws.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/security-gate.ts:98` | `runSecurityAudit(contract, evaluation, projectRoot, config)` | low | Calls positionally with 4 args. Appending an optional `deps` (6th) param is safe — do NOT reorder existing params. |
| `src/cli/commands/security-audit.ts:118,144` | `typeof runSecurityAudit` (aliased as `deps.runAudit`) | medium | Uses `typeof runSecurityAudit` in its own deps type. Changing the signature widens that type; a NEW trailing OPTIONAL param keeps it assignable. Verify `src/cli/commands/security-audit.test.ts` fakes (`as unknown as typeof runSecurityAudit`) still typecheck. |
| `src/orchestrator/pipeline.test.ts:120,287+` | `vi.mock` of `runSecurityAudit` | low | Mocked wholesale; unaffected by a new optional param. |
| `src/config/schema.ts:633` root `security` | `SecuritySectionSchema` | low | Adding an optional field to the section does not change the root wiring. |
| Everything importing `BoberConfig` | `config.security` shape | low | New field is optional; existing configs parse unchanged. |

### Existing Tests That Must Still Pass (grep-verified dependents)
- `src/orchestrator/security-auditor-agent.test.ts` — the **nonGoal read-only-toolset tests (lines 422-452)** assert the tools array has `read_file/glob/grep` and NO `bash/write_file/edit_file`, and that `toolHandlers.has("bash") === false`. Your change must not touch tool resolution → these stay green (this is the ADR-5 guard for sc-6-5).
- `src/orchestrator/security-auditor-agent.test.ts:456-515` — sc-5-4 scanner-pre-filter wiring (AbortController/timeout shape). Your new diff block sits alongside it; don't perturb the `scannerPreFilterSpy` expectations.
- `src/orchestrator/security-auditor-agent.test.ts:285-333` — sc-2-3 prompt-fragment assertions. In `estimated-files` mode (default) the resolver must still receive `contract.estimatedFiles`/`[]`, so these must pass UNCHANGED (proves the byte-identical default).
- `src/config/schema.test.ts:639-695` — the SecuritySection deep-equal + reject tests (must stay green → `diff` MUST be `.optional()` with no outer default).
- `src/orchestrator/security-gate.test.ts` and `src/cli/commands/security-audit.test.ts` — call/mocks of `runSecurityAudit`; verify positional-call compatibility after the signature change.

### Features That Could Be Affected
- **Standalone `bober security-audit` CLI** (`src/cli/commands/security-audit.ts`) — shares `runSecurityAudit`. It will inherit git-diff mode automatically when `config.security.diff.mode==='git-diff'`. Verify it still works with the default (estimated-files) and that it does not gain a git dependency in the default path.
- **In-pipeline security gate** (`src/orchestrator/security-gate.ts`) — same shared core; default path unchanged.

### Recommended Regression Checks (concrete, runnable)
1. `npm run build` — TS compiles (new types + widened signature).
2. `npx vitest run src/config/schema.test.ts` — SecuritySection deep-equal byte-identical.
3. `npx vitest run src/orchestrator/security-auditor-agent.test.ts` — read-only-toolset nonGoal + estimated-files default green.
4. `npx vitest run src/orchestrator/security-knowledge/diff-provider.test.ts` — new provider suite.
5. `npx vitest run src/orchestrator/security-gate.test.ts src/cli/commands/security-audit.test.ts` — caller compatibility.
6. `npx tsc --noEmit` (or `npm run typecheck`) and `npm run lint`.
7. `npm test` — full suite green.
8. `grep -n "bash\|write_file\|edit_file" src/orchestrator/security-auditor-agent.ts` — confirm no execution tool was added; `resolveRoleTools("curator", ...)` unchanged.

---

## 8. Implementation Sequence

1. **src/config/schema.ts** — add `SecurityDiffConfigSchema` + `SecurityDiffConfig` type; add `diff: SecurityDiffConfigSchema.optional()` to `SecuritySectionSchema` (types-first, zero dependencies).
   - Verify: `SecuritySectionSchema.parse({})` still deep-equals the 8-key object (no `diff` key); `parse({diff:{}})` gives `{mode:'estimated-files',expandWithGraph:false}`.
2. **src/config/schema.test.ts** — add the paired parse tests (default absent, `{}` defaults, full round-trip, reject bogus mode).
   - Verify: `npx vitest run src/config/schema.test.ts` green.
3. **src/orchestrator/security-knowledge/diff-provider.ts** — define `DiffHunk/ChangedFile/AuditDiff`, `GitRunner`/`GitRunResult`, `SecurityDiffProvider`, `securityDiffProvider`, pure `parseUnifiedDiff` + `extractDiffKeywords`; `defaultGitRunner` copies Pattern A; baseRef resolution (merge-base with default branch via `git merge-base <default> HEAD`, fallback `HEAD~1`, all never-throw); graph neighborhood gated on `getGraphState(config).engineHealth==='ready'`.
   - Verify: file typechecks; `compute` returns `EMPTY_DIFF` on a throwing runner.
4. **src/orchestrator/security-knowledge/diff-provider.test.ts** — inject fake `GitRunner` (parse, throw→empty, cap→truncated) + fake graph (ready/not-ready/ok:false). Never shell real git.
   - Verify: `npx vitest run .../diff-provider.test.ts` green.
5. **src/orchestrator/security-auditor-agent.ts** — add `SecurityAuditDeps { diffProvider?: SecurityDiffProvider }`, append `deps: SecurityAuditDeps = {}` as the last param; insert the git-diff block before the resolver call (Pattern C timeout); feed `changedPaths`/`diffKeywords`; thread `auditDiff` into `buildUserMessage` with a conditional section (Pattern D). Leave tool resolution (lines 79-82) untouched.
   - Verify: default path (no `config.security.diff`) passes `estimatedFiles`/`[]` exactly as before.
6. **src/orchestrator/security-auditor-agent.test.ts** — add sc-6-4 (injected fake diffProvider, `.raw(` reaches prompt + matching signature selected) and sc-6-5 (git-diff mode + empty diff → estimatedFiles fallback; nonGoal toolset still read-only).
   - Verify: `npx vitest run src/orchestrator/security-auditor-agent.test.ts` green.
7. **Run full verification** — `npm run build`, `npm run typecheck` (or `npx tsc --noEmit`), `npm run lint`, `npm test`.

---

## 9. Pitfalls & Warnings

- **`diff` MUST be `.optional()` with NO outer `.default()`.** If you write `diff: SecurityDiffConfigSchema.default({})`, `SecuritySectionSchema.parse({})` will materialize a `diff` key and BREAK the existing deep-equal test at schema.test.ts:640-652 (and the sc-6-3 byte-identical guarantee). Use the `budget: BudgetSectionSchema.optional()` idiom (schema.ts:221).
- **Append `deps` as the LAST param of `runSecurityAudit`.** Callers (`security-gate.ts:98`, `security-audit.ts`) pass positionally; reordering or inserting before `priors` breaks them. `security-audit.ts` also references `typeof runSecurityAudit` in its deps type — a trailing optional param keeps it assignable.
- **Do NOT touch `resolveRoleTools("curator", ...)` (line 81) or add any tool.** Git runs ONLY inside the diff provider (orchestrator Node). Adding bash/git as a tool violates ADR-5 and trips the nonGoal tests at test lines 422-452. This is the single most-guarded invariant of the sprint.
- **`compute` must NEVER throw.** Wrap in try/catch AND use execa `reject:false` (belt-and-suspenders). ENOENT (no git), not-a-repo, detached HEAD, abort, malformed diff — all resolve to `EMPTY_DIFF`. A throw here would crash the audit; the whole point is graceful degradation to estimated-files.
- **Empty diff ≠ error.** In git-diff mode with zero changed files (or a failure), fall back to `contract.estimatedFiles`/`[]` so behavior equals estimated-files mode — no regression (sc-6-5). Only override `changedPaths`/`diffKeywords` when `changedFiles.length > 0`.
- **Graph is opt-in-within-opt-in.** Only call the GraphClient when BOTH `expandWithGraph===true` AND `getGraphState(config).engineHealth==='ready'`. `getGraphDeps()` returns `null` when not ready — guard it. Never let a graph miss (`{ok:false}`) drop the git-derived `changedFiles`.
- **`GraphClient.impact` takes a `NodeRef | string` and returns `GraphResult<ImpactReport>` (client.ts:247), not a raw array.** Read `res.data.affected` (NodeRef[]) → `.file`, only when `res.ok`. Don't assume a `.neighbors` field — the shape is `{root, affected, testsAffected}` (types.ts:73-77).
- **`utils/git.ts` has no merge-base helper and its `getDiff` lacks cancelSignal/maxBuffer.** Do not import `getDiff` and call it good — you need `--name-status`, `-U<n>`, cancelSignal, and the byte cap. Implement baseRef + parsing in the provider.
- **Bound BOTH axes:** cap `changedFiles` (~60) AND total hunk bytes (~256KB) → set `truncated:true`. An unbounded diff blows the auditor prompt (same rationale as `MAX_SCANNER_BUFFER` at security-scanners.ts:42-44 and the 2000-char excerpt cap at :263).
- **Keep the tokenizer cheap and total.** `extractDiffKeywords` feeds ranking (+2 per keyword overlap in selector.ts:20-23), not correctness (assumptions[2]). Emit identifiers plus notable substrings like `.raw(`, `FOR UPDATE`, `postinstall`, `ecrecover`, `dangerouslySetInnerHTML`. Never throw on weird hunk text.
