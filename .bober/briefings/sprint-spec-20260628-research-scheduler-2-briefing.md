# Sprint Briefing: Single-shot multi-model research run -> vault note + hub Finding

**Contract:** sprint-spec-20260628-research-scheduler-2
**Generated:** 2026-06-29T09:00:00.000Z

> Goal: `runResearchJob(job, deps)` queries >=2 DISTINCT provider/model blocks from
> `src/fleet/tier-policy.ts`, writes a markdown vault note (frontmatter: jobId, question,
> models[], generatedAt), and emits exactly ONE hub Finding through an INJECTED `findingSink`.
> Add `bober research run <jobId>`. NO web egress (that is Sprint 3). NO modifying fleet/ or medical/.

---

## 1. Target Files

### src/research/model-diversity.ts (create)

**Directory pattern:** `src/research/` files are kebab-less single-word/hyphenated module names
(`types.ts`, `job-store.ts`). Source + collocated `*.test.ts`. See `src/research/job-store.ts`.

**Most similar existing file:** none in `src/research/` yet — this is a pure read-only adapter over
`src/fleet/tier-policy.ts`. Mirror the small-module + section-header style of `job-store.ts`.

**What it must do:** import `tierPolicy` (the ONLY exported policy object) and return >=2 DISTINCT
`RoleProviderBlock` entries. CRITICAL nuance (verified): inside ONE tier, `planner === generator ===
evaluator` (same block — see tier-policy.ts:51-70). So distinctness MUST come from DIFFERENT tiers.

**Source-of-truth shape (`src/fleet/tier-policy.ts`):**
```ts
// tier-policy.ts:5
export type DifficultyTier = "default" | "cheap" | "standard" | "hard" | "frontier";

// tier-policy.ts:7-11
export interface RoleProviderBlock {
  provider: ProviderName;   // from ../providers/factory.js
  model: string;
  endpoint?: string | null;
}

// tier-policy.ts:75-82  — the ONLY runtime export to import
export const tierPolicy: TierProviderPolicy = {
  resolveTier(tier?: DifficultyTier): TieredRoleBlock | undefined { ... },
  knownTiers(): DifficultyTier[] { return ["default","cheap","standard","hard","frontier"]; },
};
```
The 4 concrete blocks (`DEEPSEEK_BLOCK` openai-compat/deepseek, `GROK_BLOCK` openai-compat/grok,
`SONNET_BLOCK` anthropic/sonnet, `OPUS_BLOCK` anthropic/opus) are **module-private const** at
tier-policy.ts:26-48 — they are NOT exported, so you cannot import them. Enumerate via
`tierPolicy.resolveTier("cheap"|"standard"|"hard"|"frontier")` and read `.generator` (or `.planner`)
off each `TieredRoleBlock`, then dedup by `provider+"/"+model`.

**Structure template:**
```ts
import { tierPolicy } from "../fleet/tier-policy.js";
import type { RoleProviderBlock, DifficultyTier } from "../fleet/tier-policy.js";

/** Canonical label for a block — used in notes + Finding evidence. */
export function modelLabel(b: RoleProviderBlock): string {
  return `${b.provider}/${b.model}`;
}

/**
 * Return >=2 DISTINCT provider/model blocks for diversity.
 * Optional `tier` seeds the first block; the rest fill from other tiers.
 * Distinctness is across tiers (within a tier planner==generator==evaluator).
 */
export function diverseBlocks(tier?: string): RoleProviderBlock[] {
  const order: DifficultyTier[] = ["cheap", "standard", "hard", "frontier"];
  const seen = new Set<string>();
  const out: RoleProviderBlock[] = [];
  const tiers = tier && order.includes(tier as DifficultyTier)
    ? [tier as DifficultyTier, ...order.filter((t) => t !== tier)]
    : order;
  for (const t of tiers) {
    const block = tierPolicy.resolveTier(t)?.generator;
    if (block && !seen.has(modelLabel(block))) { seen.add(modelLabel(block)); out.push(block); }
  }
  return out; // length 4 today; runner takes >=2
}
```

---

### src/research/note-writer.ts (create)

**Most similar existing file (template to mirror):** `src/medical/research/research-note.ts`
(do NOT import it — it lives in medical/ which is out of bounds; MIRROR its shape). It is a PURE
serializer + a path helper that delegates frontmatter rendering to `serializeFrontmatter`.

**Path helper to mirror — research-note.ts:23-26:**
```ts
export function researchNotePath(vaultDir: string, marker: string, now: string): string {
  const date = now.slice(0, 10); // YYYY-MM-DD — sliced from injected ISO, never wall-clock
  return join(vaultDir, "research", `${date}-${marker}.md`);
}
```

**Frontmatter style to mirror — research-note.ts:48-58 (object -> serializeFrontmatter):**
```ts
const frontmatter: Record<string, unknown> = {
  title: `Research — ${job.question}`,
  jobId: job.id,           // sc-2-2 required
  question: job.question,  // sc-2-2 required
  models: labels,          // sc-2-2 required — ARRAY OF STRINGS (block-list rendered)
  generatedAt: now,        // sc-2-2 required — injected ISO, never wall-clock
  domain: job.domain ?? "research",
  type: "research",
  status: "open",
};
const body = `\n## ${job.question}\n\n${contributionsMarkdown}\n`;
return serializeFrontmatter(frontmatter, body); // from ../vault/frontmatter.js
```

**Imports this file uses:**
- `serializeFrontmatter` from `../vault/frontmatter.js`
- `join` from `node:path`
- `import type { ResearchJob }` from `./types.js`

**PITFALL (verified frontmatter.ts:14-19, 145-164):** `serializeFrontmatter` supports ONLY scalars
and arrays-of-scalars. A nested object renders `key: [object Object]`. `models` MUST be `string[]`,
never `RoleProviderBlock[]`. The medical note flattens objects into parallel string arrays for exactly
this reason (research-note.ts:44-47).

**Test file:** `src/research/note-writer.test.ts` (create) — mirror `research-note.test.ts` (parse back
with `parseFrontmatter` and assert fields).

---

### src/research/runner.ts (create)

**Most similar existing file (DI template):** `src/medical/research/online-research.ts:44-153`
(deps interface with `?? default`, `opts.now` injected clock, per-item loop, build Finding, write note).

**Required signature (per contract generatorNotes):**
```ts
import type { Finding } from "../hub/finding.js";        // hub OWNS the canonical schema
import type { RoleProviderBlock } from "../fleet/tier-policy.js";
import type { ResearchJob } from "./types.js";

export type QueryModel = (block: RoleProviderBlock, prompt: string) => Promise<string>;
export type FindingSink = (finding: Finding) => Promise<void>;

export interface RunDeps {
  queryModel: QueryModel;   // provider-agnostic — NO SDK import
  findingSink: FindingSink; // CLI binds to real hub ingestFinding; tests inject a recorder
  now: string;              // injected ISO clock — NEVER call Date.now()/new Date() in this module
  vaultRoot: string;        // target vault dir
}

export interface RunResult { notePath: string; models: string[]; finding: Finding; }

export async function runResearchJob(job: ResearchJob, deps: RunDeps): Promise<RunResult> { ... }
```

**Flow:** `diverseBlocks(job.tier)` -> take >=2 -> for each block `await deps.queryModel(block, prompt)`
collecting `{ label: modelLabel(block), text }` -> synthesize markdown body + `models = labels` ->
`serializeFrontmatter` via note-writer -> `ensureDir(dirname(notePath)) + writeFile(notePath, content)`
-> build ONE full `Finding` (neutral defaults, mirror captureTask) with `surfacedAt = deps.now` ->
`await deps.findingSink(finding)` EXACTLY once -> return `{ notePath, models, finding }`.

**The Finding object (mirror src/hub/task-inbox.ts:34-46 / online-research.ts:137-148):** FindingSchema
requires more than the contract's 5 fields — `urgency` (int 1-5), `severity` (int 1-5), `tags` (string[]),
`status` (enum) are ALSO required. Supply neutral defaults:
```ts
const finding: Finding = {
  id: <stable hash of `${job.id}|${kind}` or domain|title|kind>, // mirror deriveFindingId
  domain: job.domain ?? "research",
  title: `Research: ${job.question}`,
  kind: "watch",            // enum action|watch|risk|question
  urgency: 2, severity: 2,  // neutral defaults
  evidence: labels.map((l) => `${l}`),   // model contributions/citations (string[])
  surfacedAt: deps.now,
  tags: ["research", ...(job.domain ? [`domain:${job.domain}`] : [])],
  status: "open",
};
```

**Test file:** `src/research/runner.test.ts` (create) — inject fake `queryModel` returning a distinct
string per block + a recording `findingSink`; use a temp `vaultRoot`.

---

### src/cli/commands/research.ts (modify)

**Add a `run <jobId>` subcommand on the top-level `researchCmd`** (sibling of the `job` group), inside
`registerResearchCommand`. The existing `job add|list|remove` block (lines 45-152) must stay byte-stable.

**Existing subcommand pattern to copy — research.ts:129-152 (`remove <jobId>` with positional arg):**
```ts
jobCmd
  .command("remove <jobId>")
  .description("Remove a recurring research job by id")
  .action(async (id: string) => {
    const projectRoot = await resolveRoot();
    try { ... } catch (err) {
      process.stderr.write(chalk.red(`research job remove failed: ${...}\n`));
      process.exitCode = 1;     // handlers NEVER throw — set exitCode + return
    }
  });
```

**New `run` handler must (sc-2-4):** `readJob(projectRoot, id)` -> if null: stderr + exitCode=1 + return
-> open `new FactStore(factsDbPath(projectRoot, ns))` in try/finally `store.close()` -> stamp
`const now = new Date().toISOString()` AT THE BOUNDARY -> bind `findingSink = (f) => ingestFinding(store, f, { now })`
-> bind `queryModel` (real via `createClient`, or a test-injectable default) -> `runResearchJob(job, {queryModel, findingSink, now, vaultRoot})`
-> print the returned `notePath`.

**Imports to ADD to research.ts:**
- `readJob` from `../../research/job-store.js` (extend the existing import on line 22)
- `FactStore, factsDbPath, ensureFactsDir` from `../../state/facts.js`
- `ingestFinding` from `../../hub/finding-store.js`
- `runResearchJob` (+ types) from `../../research/runner.js`
- `createClient` from `../../providers/factory.js` (only for the real queryModel binding)

**Imported by:** `src/cli/index.ts:42` (`import { registerResearchCommand }`), called at index.ts:331.

**Test file:** `src/cli/commands/research.test.ts` (EXISTS — must keep passing; see §7 for the mock pitfall).

---

## 2. Patterns to Follow

### Clock injection at the CLI boundary
**Source:** `src/cli/commands/research.ts`, lines 65-67 / `src/cli/commands/task.ts`, line 352
```ts
// Stamp wall-clock time ONLY here — never inside the store
const now = new Date().toISOString();
```
**Rule:** `new Date()` appears ONLY in the `.action()` handler. `runner.ts`, `note-writer.ts`,
`model-diversity.ts` take `now` as a parameter and never read the clock (mirrors types.ts:24, job-store).

### DI with `?? default` (injectable deps)
**Source:** `src/medical/research/online-research.ts`, lines 49-60 and 108
```ts
export interface ResearchDeps { writeFindingFn?: typeof writeFinding; /* ... */ }
const writeFindingFn = deps.writeFindingFn ?? writeFinding;
```
**Rule:** Required deps (`queryModel`, `findingSink`, `now`, `vaultRoot`) are explicit per contract;
if you add optional analyzer hooks, default them with `?? <real impl>`.

### Hub Finding write at the call site
**Source:** `src/cli/commands/task.ts`, line 288 (writer) + lines 348-359 (store lifecycle)
```ts
const ns = await resolveDefaultNamespace(projectRoot);
await ensureFactsDir(projectRoot, ns);
const store = new FactStore(factsDbPath(projectRoot, ns));
try { const action = await ingestFinding(store, payload, { now }); }
finally { store.close(); }
```
**Rule:** `ingestFinding(store, finding, { now })` is the writer to bind `findingSink` to. It accepts
`unknown`, validates with `FindingSchema.parse`, auto-fills id/surfacedAt if absent, returns a ReconcileAction.

### Neutral-default Finding construction
**Source:** `src/hub/task-inbox.ts`, lines 34-46
```ts
const finding: Finding = {
  id, domain: domain ?? DEFAULT_DOMAIN, title, kind: "action",
  urgency: 3, severity: 1, evidence: [], surfacedAt: now, tags: [...], status: "open",
};
```
**Rule:** FindingSchema requires urgency/severity/tags/status — always supply them.

### PURE markdown serializer + path helper
**Source:** `src/medical/research/research-note.ts`, lines 23-63
**Rule:** note-writer.ts is PURE (no fs, no network, no clock); the RUNNER does `ensureDir` + `writeFile`
(mirrors online-research.ts:130-133). Date for the filename is `now.slice(0, 10)`.

---

## 3. Existing Utilities — DO NOT Recreate

Reviewed: `utils/`, `vault/`, `hub/`, `state/`, `fleet/`, `providers/`, `research/`.

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `tierPolicy` | `src/fleet/tier-policy.ts:75` | `{ resolveTier(tier?): TieredRoleBlock\|undefined; knownTiers(): DifficultyTier[] }` | THE model-diversity source. Read `.generator`/`.planner` off each tier. |
| `serializeFrontmatter` | `src/vault/frontmatter.ts:145` | `(fm: Record<string,unknown>, body: string) => string` | Render `---\nYAML\n---\nbody`. Scalars + string-arrays ONLY. |
| `parseFrontmatter` | `src/vault/frontmatter.ts:53` | `(raw: string) => { frontmatter; body }` | Parse note back — use in note-writer.test.ts to assert. |
| `writeNote` | `src/vault/note-io.ts:38` | `(note: VaultNote) => Promise<void>` | ensureDir+writeFile a `{frontmatter, body, path}`. Alt to manual write. |
| `ensureDir` | `src/utils/fs.ts:45` | `(path: string) => Promise<void>` | mkdir -p before writeFile. (Also re-exported via state/helpers.) |
| `ingestFinding` | `src/hub/finding-store.ts:140` | `(store, input: unknown, { now }) => Promise<ReconcileAction>` | Bind `findingSink` here. Validates + auto-fills id/surfacedAt. |
| `writeFinding` | `src/hub/finding-store.ts:17` | `(store, finding: Finding, { now }) => Promise<ReconcileAction>` | Lower-level full-Finding writer (ingestFinding wraps it). |
| `FindingSchema` / `Finding` | `src/hub/finding.ts:10` / `:27` | Zod object / `z.infer` | CANONICAL Finding. Import the TYPE; never redefine. |
| `createClient` | `src/providers/factory.ts:192` | `(provider?, endpoint?, providerConfig?, model?, role?) => LLMClient` | Build a real LLM client for the CLI's queryModel binding. |
| `FactStore` / `factsDbPath` | `src/state/facts.ts:136` / `:77` | `new FactStore(path)` / `(root, ns?) => string` | Open the hub store at the CLI boundary. |
| `ensureFactsDir` | `src/state/facts.ts:86` | `(root, ns?) => Promise<...>` | Ensure facts dir before opening the store. |
| `readJob` | `src/research/job-store.ts:100` | `(root, id) => Promise<ResearchJob\|null>` | Load the stored job in the `run` handler. |
| `jobId` | `src/research/job-store.ts:28` | `(question, createdAt) => string` | 16-char sha256 id helper (pattern to copy for a Finding id). |
| `findProjectRoot` | `src/utils/fs.ts:58` | `() => Promise<string\|undefined>` | Already used via `resolveRoot()` in research.ts:27. |

---

## 4. Prior Sprint Output

### Sprint 1 (commit 0336e47): research job model + store + `research job` CLI
**Created `src/research/types.ts`** — exports `ResearchJobSchema` (Zod) + `ResearchJob` type (fields:
`id, question, cadence, tier?, modelSet?, targetRepo?, domain?, onlineResearch, createdAt`) and
`CadenceSchema`/`Cadence`. (types.ts:14, 33-56)
**Connection:** the runner CONSUMES `ResearchJob`. `job.tier` seeds `diverseBlocks`; `job.question`
drives the prompt + note title; `job.domain` -> Finding.domain + note frontmatter.

**Created `src/research/job-store.ts`** — exports `addJob/listJobs/readJob/removeJob` over
`.bober/research/jobs/<id>.json` (clock-free, async-only) + `jobId(question, createdAt)`. (job-store.ts:28-129)
**Connection:** the `run <jobId>` handler calls `readJob(projectRoot, id)` to load the stored job.

**Created `src/cli/commands/research.ts`** — `registerResearchCommand(program)` with `research job add|list|remove`.
Wired in `src/cli/index.ts:42, 331`.
**Connection:** Sprint 2 ADDS a `run <jobId>` subcommand to THIS SAME function (do not create a new command file).

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md` — EXISTS)
Hard gates the Generator MUST honor:
- **ESM everywhere** — all relative imports end in `.js` (NodeNext). (principles L27)
- **Provider-agnostic interfaces** — never import an LLM SDK (`@anthropic-ai/sdk`, `openai`) outside
  `providers/` adapters. `queryModel` is a slim `(block, prompt) => Promise<string>` — keep it SDK-free. (L28, L41)
- **`import type { ... }`** — consistent-type-imports is enforced (ESLint hard gate). Use it for `Finding`,
  `ResearchJob`, `RoleProviderBlock`, etc. (L35)
- **No synchronous fs** — `node:fs/promises` only (`writeFile`, `mkdir`). (L42)
- **Clock injection** — `now` stamped only at the CLI handler; pure modules take it as a param. (mirrors L31/L33)
- **Strict TS** — `noUnusedLocals/Parameters` (prefix unused with `_`), `noImplicitReturns`. Zero type errors is a gate. (L18)
- **Section comments** — `// -- Section Name ------` box headers. (L32)
- **Tests collocated** — `*.test.ts` next to source; Vitest; NO fs mocks (use temp dirs). (L20, L44)

### Architecture Decisions
No `.bober/architecture/` doc specific to the research scheduler. The hub's canonical-schema rule
(`src/hub/finding.ts:5-9`: "All other modules that produce or consume Findings MUST import from here.
Do NOT redefine Finding anywhere else") is the governing ADR-equivalent for this sprint.

---

## 6. Testing Patterns

### Unit Test Pattern — temp dir + injected deps
**Source:** `src/research/job-store.test.ts:1-34` (lifecycle) + `src/medical/research/research-note.test.ts`
```ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

let tmpRoot: string;
beforeEach(async () => { tmpRoot = await mkdtemp(join(tmpdir(), "bober-research-run-")); });
afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }); });
```
**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** prefer INJECTED fakes over
`vi.mock` (principles L44 — no fs mocks). **File naming:** `*.test.ts` collocated.

**runner.test.ts skeleton (sc-2-1 / sc-2-2 / sc-2-3):**
```ts
const NOW = "2026-06-28T12:00:00.000Z";
const calls: Finding[] = [];
const findingSink = async (f: Finding) => { calls.push(f); };
const queryModel = async (b: RoleProviderBlock, _p: string) => `answer from ${b.provider}/${b.model}`;

const job = ResearchJobSchema.parse({ id: "j1", question: "Q?", cadence: "weekly",
  onlineResearch: false, createdAt: NOW });

const res = await runResearchJob(job, { queryModel, findingSink, now: NOW, vaultRoot: tmpRoot });

// sc-2-1: >=2 distinct model labels recorded in the note
const raw = await readFile(res.notePath, "utf-8");
const { frontmatter } = parseFrontmatter(raw);
expect(new Set(frontmatter["models"] as string[]).size).toBeGreaterThanOrEqual(2);

// sc-2-2: required frontmatter
expect(frontmatter["jobId"]).toBe("j1");
expect(frontmatter["question"]).toBe("Q?");
expect(frontmatter["generatedAt"]).toBe(NOW);

// sc-2-3: exactly one Finding with required fields
expect(calls).toHaveLength(1);
expect(calls[0]).toMatchObject({ domain: expect.any(String), title: expect.any(String),
  kind: expect.any(String), surfacedAt: NOW });
expect(Array.isArray(calls[0].evidence)).toBe(true);
```

### CLI Test Pattern (for the `run` action)
**Source:** `src/cli/commands/research.test.ts:29-62` — `vi.mock("../../utils/fs.js", () => ({ findProjectRoot: vi.fn() }))`,
`program.exitOverride()`, `registerResearchCommand(program)`, `program.parseAsync(["node","bober",...args],{from:"node"})`,
spy on `process.stdout.write`. **See §7 for the mock-surface pitfall.**

### E2E Test Pattern
Not applicable — no Playwright in this repo (CLI/library only; principles "Design Principles: N/A — no UI").

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/index.ts` | `registerResearchCommand` (research.ts) | low | Signature unchanged (still `(program)`); `run` is additive. |
| `src/cli/commands/research.test.ts` | `registerResearchCommand` + module mock of `utils/fs.js` | **HIGH** | The test mocks the WHOLE `utils/fs.js` to ONLY `{ findProjectRoot }`. If `run` wiring imports ANY new symbol from `utils/fs.js` (e.g. `ensureDir`), it is `undefined` in that test and the existing `job` tests crash. Keep research.ts's `utils/fs.js` import limited to `findProjectRoot`; do fs work inside runner.ts/note-writer.ts. |
| `src/fleet/tier-policy.ts` | read-only by new model-diversity.ts | none | Do NOT modify (contract nonGoal L40). Only import `tierPolicy` + types. |
| `src/hub/finding.ts` / `finding-store.ts` | read-only (type + ingestFinding) | none | Do NOT redefine Finding; bind to `ingestFinding`. |

### Existing Tests That Must Still Pass
- `src/cli/commands/research.test.ts` — covers `research job add|list|remove` (sc-1-3). Adding `run`
  must not change their argv routing or output. Risk: the `utils/fs.js` module mock (see above).
- `src/research/job-store.test.ts` — covers the store + `jobId`/`readJob`. Untouched by Sprint 2; verify still green.
- `src/medical/research/research-note.test.ts` + `src/hub/finding-store.test.ts` — unaffected (you only
  READ those modules / mirror their shape). Confirm no accidental edits to medical/ or hub/.

### Features That Could Be Affected
- **priority-hub (spec-20260628-priority-hub)** — shares `src/hub/finding-store.ts` + `FindingSchema`.
  Verify the emitted Finding satisfies `FindingSchema.parse` (urgency/severity/tags/status present) so
  `ingestFinding` does not throw and hub `readFindings`/ranking keeps working.
- **medical recommend (`src/medical/recommend/recommend.ts`)** — the ONLY other tier-policy importer.
  You don't touch it; confirm tier-policy.ts is unmodified so it stays intact.

### Recommended Regression Checks
1. `npm run build` — clean tsc (sc-2-4, hard gate).
2. `npx vitest run src/cli/commands/research.test.ts` — existing job CLI tests still pass (mock pitfall).
3. `npx vitest run src/research/` — new runner + note-writer tests + existing job-store tests pass.
4. `npx vitest run src/hub/finding-store.test.ts` — hub writer unaffected.
5. `npm run lint` (or eslint) — consistent-type-imports + no-unused gates.

---

## 8. Implementation Sequence

1. **src/research/model-diversity.ts** — `modelLabel(block)` + `diverseBlocks(tier?)` over `tierPolicy`.
   - Verify: `diverseBlocks()` returns >=2 entries with distinct `provider/model` labels (unit-assertable).
2. **src/research/note-writer.ts** — `researchNotePath(vaultRoot, marker, now)` + pure
   `serializeResearchNote(job, labels, contributions, now)` using `serializeFrontmatter`.
   - Verify: `parseFrontmatter(output)` yields `jobId/question/models[]/generatedAt`; no `[object Object]`.
3. **src/research/note-writer.test.ts** — assert frontmatter fields + path shape (mirror research-note.test.ts).
   - Verify: tests pass with `npx vitest run src/research/note-writer.test.ts`.
4. **src/research/runner.ts** — `runResearchJob(job, {queryModel, findingSink, now, vaultRoot})`: loop
   >=2 blocks -> collect labelled contributions -> write note (ensureDir+writeFile) -> build ONE full
   `Finding` -> `await findingSink(finding)` once -> return `{ notePath, models, finding }`.
   - Verify: imports `type { Finding }` from hub; never calls `new Date()`; sink invoked exactly once.
5. **src/research/runner.test.ts** — fake `queryModel` (distinct per block) + recording `findingSink` +
   temp `vaultRoot`; assert sc-2-1/2-2/2-3.
   - Verify: `npx vitest run src/research/runner.test.ts` green.
6. **src/cli/commands/research.ts** — add `run <jobId>` on `researchCmd`: `readJob` -> open FactStore ->
   stamp `now` -> bind `findingSink = (f) => ingestFinding(store, f, { now })` -> bind `queryModel` (real
   via `createClient`) -> `runResearchJob` -> print `res.notePath` -> `store.close()` in finally; never throw.
   - Verify: existing research.test.ts still passes (mock surface unchanged); `--help` lists `run`.
7. **Run full verification** — `npm run build`, `npx vitest run src/research/ src/cli/commands/research.test.ts src/hub/finding-store.test.ts`, lint.

---

## 9. Pitfalls & Warnings

- **utils/fs.js module mock (research.test.ts:29).** The existing CLI test replaces the ENTIRE
  `utils/fs.js` with `{ findProjectRoot }`. Importing another symbol from it into research.ts (e.g.
  `ensureDir`) makes that symbol `undefined` and breaks the passing job tests. Keep all fs work in
  runner.ts/note-writer.ts; research.ts should import only `findProjectRoot` from utils/fs.js (as today).
- **Diversity is ACROSS tiers, not within one.** In every tier `planner === generator === evaluator`
  (tier-policy.ts:51-70). Picking three roles from ONE tier yields ONE distinct block. Enumerate
  different tiers (cheap/standard/hard/frontier) and dedup by `provider/model`.
- **The 4 tier blocks are NOT exported** (tier-policy.ts:26-48 are `const`). You MUST go through
  `tierPolicy.resolveTier(...)`. Do not try to import `DEEPSEEK_BLOCK` etc.
- **serializeFrontmatter renders nested objects as `[object Object]`** (frontmatter.ts:152-160). `models`
  must be `string[]` (the labels), never `RoleProviderBlock[]`.
- **FindingSchema has MORE required fields than the contract's 5.** `urgency`, `severity`, `tags`,
  `status` are also required (finding.ts:16-23). Build the Finding with neutral defaults or
  `ingestFinding`/`FindingSchema.parse` will THROW.
- **Do NOT import `src/medical/research/research-note.ts`** — it is in medical/ (nonGoal L40). MIRROR its
  shape in your own note-writer.ts. Likewise do not import any `src/medical/` or modify `src/fleet/`.
- **No web egress this sprint** (Sprint 3). The runner ONLY calls the injected `queryModel`; it must not
  open sockets, add an egress axis, or use `FleetCoordinator` (nonGoals L37-39).
- **Clock discipline.** `new Date()` only in the research.ts `.action()` handler. runner/note-writer/
  model-diversity take `now` as a param. `generatedAt`/`surfacedAt` = injected `now`; filename date =
  `now.slice(0, 10)`.
- **`.js` extensions on every relative import** (NodeNext) and `import type` for all type-only imports
  (ESLint hard gates).
