# Sprint Briefing: No committed contract carries a status the schema forbids

**Contract:** sprint-spec-20260812-terminal-vocabulary-2
**Generated:** 2026-08-12T00:00:00Z

---

## 0. READ THIS FIRST — three contract premises are FALSE

Verified empirically against the repo. Do not act on the contract's wording without reading this section.

| Premise (from contract / orchestrator) | Reality | Evidence |
|---|---|---|
| "they load only because `loadContract` parses non-strictly" | **FALSE.** `loadContract` DOES use `SprintContractSchema.safeParse` and DOES throw. These four files do not load at all — `listContracts` silently drops them. | `src/state/sprint-state.ts:96-101` (strict), `:137-140` (silent skip) |
| "all with `completedAt: null`" | **FALSE.** None of the four has a `completedAt` key at all. Their key set is `contractId, specId, sprintNumber, title, status, description, filesInScope, successCriteria, generatorNotes, evaluatorNotes`. | measured; see §1.3 |
| "this work was proposed and never carried out" | **FALSE.** All four sprints were executed on 2026-06-04 and every deliverable landed. The parent spec was marked `abandoned` 40 days *later* for a different reason (stale vs 0.18.0). | see §1.4 — this decides sc-2-1 |

---

## 1. Target Files

### `.bober/contracts/sprint-spec-20260604-docs-correction-{1,2,3,4}.json` (modify)

#### 1.1 Actual shape (file 1, verbatim head)

```json
{
  "contractId": "sprint-spec-20260604-docs-correction-1",
  "specId": "spec-20260604-docs-correction",
  "sprintNumber": 1,
  "title": "CHANGELOG [0.16.0] + npm metadata",
  "status": "pending",
  "description": "Cut a dated [0.16.0] CHANGELOG entry covering all features shipped after 0.15.0 ...",
  "filesInScope": ["CHANGELOG.md", "package.json"],
  "successCriteria": [
    "CHANGELOG.md has '## [0.16.0] — 2026-06-04' between an empty '## [Unreleased]' and '## [0.15.0]' ...",
    ...
  ],
  "generatorNotes": "...",
  "evaluatorNotes": "..."
}
```

These are **pre-schema-era** files: `successCriteria` is an array of **strings**, not `SuccessCriterion` objects; `filesInScope` predates `estimatedFiles`; `nonGoals` / `stopConditions` / `definitionOfDone` do not exist.

**The one line to change, in each of the four files:**
```json
  "status": "pending",
```
→
```json
  "status": "completed",
```
(justification in §1.4). nonGoal 2 forbids touching anything else — **do not** add `completedAt`, do not reshape `successCriteria`, do not rename `filesInScope`.

#### 1.2 The strict-parse gap — where and why

`loadContract` is strict and would throw on all four:

```ts
// src/state/sprint-state.ts:96-101
  const result = SprintContractSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Contract "${id}" failed validation:\n${formatZodIssues(result.error)}`,
    );
  }
```

The actual leak is `listContracts`, which swallows the failure:

```ts
// src/state/sprint-state.ts:106-112 (doc comment)
 * Files that fail validation are skipped silently — to surface validation
 * errors, use `loadContract` directly. (Skipping is intentional here so that
 * a single bad file doesn't break listing for the rest.)

// src/state/sprint-state.ts:132-144
  for (const file of jsonFiles) {
    const filePath = join(dir, file);
    try {
      const content = await readFile(filePath, "utf-8");
      const parsed: unknown = JSON.parse(content);
      const result = SprintContractSchema.safeParse(parsed);
      if (result.success) {
        contracts.push(result.data);
      }
    } catch {
      // Skip malformed files
    }
  }
```

`clearContractsForSpec` (`src/state/sprint-state.ts:179-190`) reads the raw JSON with `JSON.parse` and only touches `specId` — it never validates, which is the *actual* code path under which an illegal `status` survives untouched on disk.

#### 1.3 EXACTLY which fields are invalid — MEASURED, not assumed

Ran `SprintContractSchema.safeParse` over all 256 files in `.bober/contracts/` (via `dist/contracts/sprint-contract.js`):

```
TOTAL=256   STRICT_OK=196   STRICT_BAD=60
```

Per-file issue paths for the four offenders:

| File | Invalid paths |
|---|---|
| `...docs-correction-1.json` | `status[invalid_enum_value]`, `successCriteria.0..5[invalid_type]`, `nonGoals[invalid_type]`, `stopConditions[invalid_type]`, `definitionOfDone[invalid_type]` |
| `...docs-correction-2.json` | `status[invalid_enum_value]`, `successCriteria.0..4[invalid_type]`, `nonGoals`, `stopConditions`, `definitionOfDone` |
| `...docs-correction-3.json` | `status[invalid_enum_value]`, `successCriteria.0..2[invalid_type]`, `nonGoals`, `stopConditions`, `definitionOfDone` |
| `...docs-correction-4.json` | `status[invalid_enum_value]`, `successCriteria.0..4[invalid_type]`, `nonGoals`, `stopConditions`, `definitionOfDone` |

**Simulation of the fix** (set `status: "completed"` in memory, re-parse):

```
file 1: strictParse=false  remainingIssueFields=successCriteria|nonGoals|stopConditions|definitionOfDone
file 2: strictParse=false  remainingIssueFields=successCriteria|nonGoals|stopConditions|definitionOfDone
file 3: strictParse=false  remainingIssueFields=successCriteria|nonGoals|stopConditions|definitionOfDone
file 4: strictParse=false  remainingIssueFields=successCriteria|nonGoals|stopConditions|definitionOfDone
```

> **⚠ THE DECISIVE CONSTRAINT.** Migrating the status **will not** make these files load. Repairing them fully is forbidden by nonGoal 2 ("Rewriting any other field of those four contracts"). Therefore **sc-2-2's test MUST validate the `status` field alone against `ContractStatusSchema` — it must NOT validate the whole file against `SprintContractSchema`.** A whole-schema test would fail on 60 of 256 files and could only be made green by violating nonGoal 2. The criterion's own wording already says this: *"asserts its **status** parses against **ContractStatusSchema**"*. Read it literally.
>
> Corollary: the `listContracts` count is **unchanged** by this sprint (196 before, 196 after). That is what makes §3 safe.

Also measured — the other 56 bad files fail for unrelated legacy reasons (`contractId[invalid_type]`, `verificationMethod[invalid_enum_value]`, `estimatedDuration[invalid_enum_value]`, `completedAt[invalid_type]` from `null`). **Zero files fail on `status` alone.** Fixing the wider corpus is not this sprint.

#### 1.4 sc-2-1 — WHICH legal value, and the stopCondition

The contract's stopCondition: *"Migrating a status would change what a completed spec's history claims — if so, report which and pick the value that preserves the record."* **It fires. Here is the record.**

The parent spec is `abandoned`:
```
.bober/specs/spec-20260604-docs-correction.json
  status          = "abandoned"
  abandonedReason = "Superseded 2026-07-14: written for 0.16.0, but repo is now 0.18.0
                     (tags through v0.18.0). Re-scoped into a fresh 0.18.0 docs/metadata
                     refresh spec at user request."
```
`abandonedReason` says **superseded**, not *never run*. `.bober/history.jsonl` is unambiguous:

```jsonc
// .bober/history.jsonl:271
{"event":"plan-created","specId":"spec-20260604-docs-correction","sprintCount":4,"timestamp":"2026-06-04T18:13:40Z"}
// .bober/history.jsonl:272
{"event":"plan-completed","specId":"spec-20260604-docs-correction","sprintCount":4,
 "branch":"bober/docs-correction-0.16.0","commit":"0a39fa8",
 "tags":["v0.12.0","v0.13.0","v0.14.0","v0.15.0","v0.16.0"],"pushed":false,...}
// .bober/history.jsonl:919 — 40 days later, a SEPARATE event
{"event":"spec-superseded","specId":"spec-20260604-docs-correction","reason":"stale-0.16.0-repo-now-0.18.0","timestamp":"2026-07-14T20:30:00Z"}
```

Every sprint's deliverable is verifiably on disk **today**:

| Sprint | Its own success criterion | Verified |
|---|---|---|
| 1 | `## [0.16.0] — 2026-06-04` between `[Unreleased]` and `[0.15.0]` | `CHANGELOG.md:59` |
| 2 | a "Lens Panels" README section | `README.md:784` — `## Lens Panels (multi-perspective evaluation & architecture)` |
| 3 | `DEEPSEEK_API_KEY` in COMMANDS.md; `pipeline.engine` in VISION.md | 6 hits in `COMMANDS.md`; 1 in `VISION.md` |
| 4 | annotated `v0.12.0→e30099f, v0.13.0→0ffc81e, v0.14.0→b83d641, v0.15.0→95f9965`, `v0.16.0`→doc-release commit | `git cat-file -t` = `tag` (annotated) for all five; targets match **exactly**; `v0.16.0 → 0a39fa8`, the same commit history.jsonl records, whose subject is `docs(release): v0.16.0 — lens panels, workflow engine, multi-provider, graph telemetry`. Branch `bober/docs-correction-0.16.0` exists locally and on origin. |

**Recommendation: `"completed"` for all four. Justify it with the evidence above in the commit message.**

- `"completed"` is what 219 of the 256 corpus contracts use — the corpus's own word for a finished sprint (`SETTLED_CONTRACT_STATUSES`, `src/contracts/sprint-contract.ts:69-72`).
- `"proposed"` would be **factually wrong** and would destroy the record the stopCondition tells you to preserve.
- **Do NOT choose `"passed"`.** Semantically it is also settled, but `src/mcp/tools/sprint-corpus.test.ts:62-71` pins *"the corpus contains zero contracts whose status is the literal string `passed`"* as this plan's documented root cause. Choosing `"passed"` puts the four files one future repair away from falsifying that pin. `"completed"` has no such interaction.

---

### `src/contracts/sprint-contract.test.ts` (modify — add the guard)

**Current state:** 318 lines, a **pure in-memory unit test** — no `node:fs` import anywhere. Header (`:1-18`) imports only from `./sprint-contract.js`, including `ContractStatusSchema`:

```ts
// src/contracts/sprint-contract.test.ts:1-18
import { describe, it, expect } from "vitest";

import {
  SprintContractSchema,
  ContractStatusSchema,
  createContract,
  ...
} from "./sprint-contract.js";
```

**Placement decision.** `estimatedFiles` names this file, and appending here is acceptable. But the closer sibling is `src/contracts/status-vocabulary.invariant.test.ts` — sprint 1's new corpus-scanning invariant, in the same directory, which already carries the `readdir` + `REPO_ROOT` + mutation-control machinery. Either is defensible; if you append to `sprint-contract.test.ts`, add the fs imports in a **separate `// ── corpus guard ──` section** per the repo's section-comment principle (`.bober/principles.md`: *"Use unicode box-drawing section headers"*), and do not disturb the existing pure unit tests.

---

## 2. Patterns to Follow

### Pattern A — "read the directory at run time, then mutate a TEMP COPY to prove it bites" (the shape sc-2-3/sc-2-4 want)
**Source:** `src/pge/golden/dataset.test.ts:27-82`

```ts
/**
 * The COMMITTED dataset, checked against the COMMITTED graph.
 *
 * Two rules govern this file. The count is taken by reading the directory, never from a
 * list written down here — a hardcoded list is a list that drifts, and the first thing it
 * hides is a case someone deleted. And every gate it asserts is driven from both sides:
 * each positive assertion about the real dataset has a negative control that breaks the
 * same precondition on a TEMP COPY and proves the check fails. The committed artifact and
 * the committed dataset are never mutated.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GOLDEN_DIR = join(REPO_ROOT, ".bober", "golden");
...
beforeAll(async () => {
  files = (await readdir(GOLDEN_DIR)).sort();
  ...
});

const tempDirs: string[] = [];

/** A writable copy of the committed dataset. The committed one is never touched. */
async function copyDataset(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "golden-dataset-"));
  tempDirs.push(dir);
  for (const file of files) await copyFile(join(GOLDEN_DIR, file), join(dir, file));
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  }
});
```

The positive assertion (`dataset.test.ts:87-90`) and its negative control (`:169-180`) are the exact pair sc-2-2 + sc-2-3 ask for:

```ts
// src/pge/golden/dataset.test.ts:87-90 — positive, counted off the directory
  it("holds between 20 and 50 files, counted by reading the directory", () => {
    expect(files.length).toBeGreaterThanOrEqual(GOLDEN_DATASET_MIN_CASES);
    expect(files.length).toBeLessThanOrEqual(GOLDEN_DATASET_MAX_CASES);
  });

// src/pge/golden/dataset.test.ts:227-238 — negative control: mutate ONE field in a temp copy
  it("fails when a case pins a node the graph no longer has", async () => {
    const dir = await copyDataset();
    const target = files[0];
    const draft = JSON.parse(await readFile(join(dir, target), "utf-8")) as Record<string, unknown>;
    const pinned = draft.pinnedResponses as Record<string, unknown>[];
    pinned[0].nodeId = "node_that_was_renamed";
    await writeFile(join(dir, target), JSON.stringify(draft, null, 2), "utf-8");

    const validation = await validateGoldenDataset({ dir, facts });
    expect(validation.exitCode).toBe(GOLDEN_EXIT.usage);
    expect(validation.problems.join(" ")).toContain("no such node");
  });
```

**Rule:** compute the file list with `readdir` in `beforeAll`, never a literal array; for the mutation control, `mkdtemp` under `os.tmpdir()`, `copyFile` the committed files in, mutate the copy, and `rm -rf` in `afterEach`. `mkdtemp(join(tmpdir(), ...))` is outside the repo, so a crashed run leaves nothing behind under `.bober/`.

### Pattern B — split the check into a PURE function so mutation control needs no disk at all
**Source:** `src/contracts/status-vocabulary.invariant.test.ts:82-102` (sprint 1, this sprint's direct predecessor)

```ts
/**
 * Pure — takes in-memory files, never touches disk. This is what the
 * mutation-control tests below drive directly with synthetic content, so
 * "the scan bites" is proven without ever writing a scratch file under src/
 * (a crashed run would otherwise leave one behind — see
 * src/pge/lint-boundary.test.ts's identical rationale for its ESLint
 * `lintText` approach).
 */
function findOffenders(files: SourceFile[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const lines = file.content.split("\n");
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      if (OFFENDER_PATTERN.test(line)) {
        offenders.push(`${file.path}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  return offenders;
}
```

with a liveness assertion so a broken walk can't pass vacuously:

```ts
// src/contracts/status-vocabulary.invariant.test.ts:236-239
  it("the walk actually happens against the real tree", async () => {
    const files = await realSourceFiles();
    expect(files.length).toBeGreaterThan(200);
  });
```

and the in-memory mutation control:

```ts
// src/contracts/status-vocabulary.invariant.test.ts:293-309
  it("bites: a synthetic 'passed' comparison outside the allowlist is reported", () => {
    const files: SourceFile[] = [
      { path: "src/hypothetical/sixth-reader.ts", content: [...].join("\n") },
    ];
    const offenders = findOffenders(files);
    expect(offenders).toEqual(['src/hypothetical/sixth-reader.ts:2: return c.status === "passed";']);
  });
```

**Rule:** factor the check as `findIllegalStatuses(entries: {file: string; status: unknown}[]): string[]`. Drive it from `readdir` for the real assertion; drive it from a literal array for the "bites" assertion.

**Recommended synthesis:** sc-2-3 says *"an illegal status introduced in a **temp copy** fails it"*. To satisfy that literally **and** keep Pattern B's safety, do both:
1. a pure `findIllegalStatuses(...)` + in-memory "bites" test (Pattern B), **and**
2. one `mkdtemp`-backed test that copies the real `.bober/contracts/` into `os.tmpdir()`, rewrites one file's `status` to `"pending"`, and asserts the directory-reading scan run against that temp dir reports exactly that file (Pattern A).

Keep a liveness assertion (`expect(entries.length).toBeGreaterThan(200)`) so an empty/failed `readdir` cannot pass silently — the corpus is 256 files today.

### Pattern C — locating REPO_ROOT from a test file
Two spellings in use; both correct. Depth differs by directory, so count carefully — `src/contracts/*` is **two** levels under root.

```ts
// src/contracts/status-vocabulary.invariant.test.ts:58 — from src/contracts/
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// src/mcp/tools/sprint-corpus.test.ts:31 — from src/mcp/tools/
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
```

**Rule:** from `src/contracts/`, use `"../../"` (or `join(dirname(...), "..", "..")`), then `join(REPO_ROOT, ".bober", "contracts")`.

### Pattern D — ESM + type imports (hard gates)
`.bober/principles.md`: *"All imports use `.js` extensions for NodeNext resolution"*, *"ESLint enforces `consistent-type-imports`"*, *"All fs operations use `node:fs/promises`. No `fs.readFileSync`"*. Confirmed in every file cited above (e.g. `src/state/sprint-state.ts:1` `from "node:fs/promises"`, `:4` `import type { ZodError } from "zod";`, `:10` `"../contracts/sprint-contract.js"`).

---

## 3. Existing Utilities — DO NOT Recreate

Directories reviewed: `src/utils/`, `src/state/`, `src/contracts/`. (`src/lib/`, `src/helpers/`, `src/shared/`, `src/common/` do not exist in this repo.)

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `ContractStatusSchema` | `src/contracts/sprint-contract.ts:38-48` | `z.ZodEnum<[...9 members]>` | **The nine legal statuses. This is what sc-2-2 must parse against.** Already imported by `sprint-contract.test.ts:5`. |
| `ContractStatus` | `src/contracts/sprint-contract.ts:49` | `type = z.infer<typeof ContractStatusSchema>` | The status union type. |
| `SprintContractSchema` | `src/contracts/sprint-contract.ts:151-202` | `z.ZodObject<...>` | Whole-contract schema. **Do NOT use for sc-2-2** — 60/256 committed files fail it (§1.3). |
| `isSettledContractStatus` | `src/contracts/sprint-contract.ts:101-103` | `(status: ContractStatus) => boolean` | Sprint 1's "settled successfully" predicate (`passed`/`completed`). |
| `isTerminalContractStatus` | `src/contracts/sprint-contract.ts:116-118` | `(status: ContractStatus) => boolean` | Sprint 1's "sprint is over" predicate (adds `failed`). |
| `listContracts` | `src/state/sprint-state.ts:113-147` | `(projectRoot: string) => Promise<SprintContract[]>` | Lists contracts, **silently dropping schema-invalid files** — the leak in §1.2. Unusable for sc-2-2: it cannot see the offenders. |
| `loadContract` | `src/state/sprint-state.ts:70-104` | `(projectRoot: string, id: string) => Promise<SprintContract>` | Strict single load; throws. Would throw on all four even after the fix. |
| `clearContractsForSpec` | `src/state/sprint-state.ts:166-191` | `(projectRoot: string, specId: string) => Promise<void>` | Raw `JSON.parse`, reads only `specId`; never validates. |
| `readJson` | `src/utils/fs.ts:24-27` | `<T = unknown>(path: string) => Promise<T>` | `readFile` + `JSON.parse`. Use instead of hand-rolling in production code. |
| `writeJson` | `src/utils/fs.ts:34` | `(path, data, ...) => Promise<void>` | Pretty-printed JSON write; creates parent dirs. |
| `fileExists` | `src/utils/fs.ts:10` | `(path: string) => Promise<boolean>` | Existence check. |
| `ensureDir` | `src/utils/fs.ts:45` / `src/state/helpers.ts:6` | `(path: string) => Promise<void>` | `mkdir -p`. Two copies exist — don't add a third. |
| `findProjectRoot` | `src/utils/fs.ts:58` | `(...) => Promise<...>` | Walks up for the project root. Not needed in tests — use Pattern C. |

---

## 4. Prior Sprint Output

### Sprint 1: `sprint-spec-20260812-terminal-vocabulary-1` (completed)
**Modified:** `src/contracts/sprint-contract.ts` — added `SETTLED_CONTRACT_STATUSES` (`:69-72`), `TERMINAL_CONTRACT_STATUSES` (`:84-87`), `isSettledContractStatus` (`:101-103`), `isTerminalContractStatus` (`:116-118`); `updateContractStatus` (`:285`) now calls the predicate.
**Created:** `src/contracts/status-vocabulary.invariant.test.ts` — a source-scanning invariant with a documented `ALLOWLIST` and five in-memory mutation controls.
**Created:** `src/mcp/tools/sprint-corpus.test.ts` — the only test in the repo that reads the **real** `.bober/contracts/` corpus.

**Connection to this sprint:** sprint 1 established the vocabulary *in code*; this sprint enforces it *in data*. Sprint 1's invariant test is the nearest structural sibling (same directory, corpus scan + mutation control) — reuse its `REPO_ROOT` idiom, its pure-function split, and its liveness assertion. Its allowlist mechanism is **not** needed here: after the fix there are zero legal exceptions, so the assertion is simply `expect(illegal).toEqual([])`.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`) — the clauses that bind this sprint
- *"ESM everywhere. All imports use `.js` extensions for NodeNext resolution."*
- *"Use `type` imports. ESLint enforces `consistent-type-imports`."*
- *"No synchronous filesystem ops. All fs operations use `node:fs/promises`."*
- *"No test mocks for filesystem. Tests that need filesystem state create temp directories and clean up. The scanner tests run against the real codebase."* ← directly authorises Pattern A's `mkdtemp`/`rm` shape and the run-time `readdir` of the real corpus.
- *"Tests are collocated with source (`*.test.ts` next to `*.ts`)."*
- *"Contract-based architecture. PlanSpecs, SprintContracts, and EvalResults ... are JSON files on disk in `.bober/`."*
- *"Section comments. Use unicode box-drawing section headers: `// ── Section Name ──`."*
- *"Conventional commits. Sprint-generated commits use `bober(sprint-N): description`."* ← sc-2-1 requires the justification in the commit message.
- Hard gates: zero type errors, zero lint errors, clean `tsc`.

### Architecture Decisions
`.bober/architecture/` holds ADRs for `arch-20260524-architect-a-fork-of-openhands-*` and `arch-20260529-ide-desktop-shell-*`. **None is relevant to contract status vocabulary or corpus integrity.**

### Other
No `CONTRIBUTING.md` guidance applies. `tsconfig.test.json` **only includes `src/seo/builder/**/*.ts`** — so `npm run typecheck:tests` will not typecheck your new test; `npm run typecheck` (`tsc --noEmit`, whole `src/`) is the gate that will.

---

## 6. Testing Patterns

**Runner:** vitest (`package.json` → `"test": "vitest"`). There is **no `vitest.config.ts`** — defaults apply; a test must live under the repo to be collected.
**Assertion style:** `expect(...)` from `vitest`.
**Mock approach:** none needed; the repo forbids fs mocks (see §5).
**File naming / location:** collocated `*.test.ts`; invariant-style corpus scans use `*.invariant.test.ts` (`src/contracts/status-vocabulary.invariant.test.ts`, `src/pge/runtime/__tests__/engram.invariant.test.ts`).

### Unit Test Pattern (the file you are extending)
**Source:** `src/contracts/sprint-contract.test.ts:20-58`
```ts
// A reusable, schema-valid contract for tests that need a known-good base.
function validContract(overrides: Partial<SprintContract> = {}): SprintContract {
  return {
    contractId: "sprint-test-1",
    specId: "spec-test",
    sprintNumber: 1,
    title: "Add login form",
    ...
    status: "proposed",
    ...
    ...overrides,
  };
}

describe("SprintContractSchema", () => {
  it("accepts a fully populated contract", () => {
    const result = SprintContractSchema.safeParse(validContract());
    expect(result.success).toBe(true);
  });
```

### Corpus / directory-reading test pattern
See §2 Pattern A (`src/pge/golden/dataset.test.ts:52-82, 87-90, 227-238`) and Pattern B (`src/contracts/status-vocabulary.invariant.test.ts:82-102, 236-239, 293-309`).

### E2E Test Pattern
Not applicable — no Playwright test covers this sprint (`src/evaluators/builtin/playwright.ts` is the evaluator strategy, not a suite for `.bober/` data).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### The central fact
Because the four files **remain schema-invalid after the status fix** (§1.3, simulated), `listContracts` still drops them. `STRICT_OK` stays **196 of 256** before and after. **No runtime behaviour anywhere changes.** The blast radius is genuinely near-zero — but here is the full enumeration that establishes it.

### Files That May Break
| File | Depends on | Risk | What to check |
|---|---|---|---|
| `src/state/sprint-state.ts:113` (`listContracts`) | `.bober/contracts/*.json` | **low** | Returns 196 contracts before and after (measured). Only rises if the four became fully valid — they do not. |
| `src/mcp/tools/sprint.ts:115`, `src/mcp/tools/eval.ts:80` | `listContracts` | **low** | Both build `completedContracts` via `isSettledContractStatus`. Unchanged set in ⇒ unchanged set out. |
| `src/cli/commands/sprint.ts`, `src/cli/commands/eval.ts` | `listContracts` | **low** | Same as above. |
| `src/state/history.ts:198-199` | contract statuses | **low** | Renders the `Passed`/`Failed` rows of `.bober/progress.md` from *run* records, not from a corpus re-scan. |
| `src/orchestrator/workflow/resume-cursor.ts` | contract statuses | **low** | Operates on a run's own project root, not this repo's corpus. |
| `.bober/specs/spec-20260604-docs-correction.json` | the four contracts | **none** | Do **not** touch. Its `status: "abandoned"` is correct and separately justified (§1.4). nonGoal/outOfScope. |

### Existing Tests That Must Still Pass
`src/mcp/tools/sprint-corpus.test.ts` is the **only** test that reads the real `.bober/contracts/` corpus. Every other contracts test builds a temp root (`src/orchestrator/workflow/resume-cursor.test.ts:68`, `src/pge/nodes/plan.test.ts:117-120`, `src/pge/runtime/commit.test.ts:449`, `src/pge/runtime/__tests__/exactly-once.invariant.test.ts:128`, `src/pge/nodes/gates.test.ts:471`, `src/pge/runtime/replay.test.ts:565-570`, `src/pge/engine/whole-graph.test.ts:224`, `src/orchestrator/contract-materialization.test.ts`, `src/cli/commands/plan.test.ts`) and is therefore **unaffected**.

**Are `sprint-corpus.test.ts`'s assertions count-sensitive? No — verified line by line:**

| Line | Assertion | Sensitive? |
|---|---|---|
| `:34-37` | `contracts.length` `.toBeGreaterThan(0)` | No — threshold, not a count |
| `:39-46` | `settled.length` `.toBeGreaterThan(0)` | No |
| `:48-60` | `viaPredicate === viaLiteral`, both `> 0` | No — **deliberately** so. Its own comment (`:49-52`) reads: *"not a hardcoded count, so this does not need to change when **sprint 2 migrates the four illegal `pending` contracts** and the corpus numbers shift."* Sprint 1 wrote this test anticipating you. |
| `:62-71` | `contracts.filter(c => c.status === "passed").length` `.toBe(0)` | **The one exact-value assertion.** Safe **only if you do not choose `"passed"`.** Even choosing `"passed"` would not break it today (the files still don't parse), but it makes the pin fragile. **Choose `"completed"` (§1.4).** |
| `:73-93` | source-text greps on `sprint.ts` / `eval.ts` / CLI equivalents | No — reads `src/`, not `.bober/` |

`src/contracts/status-vocabulary.invariant.test.ts` scans `src/**/*.ts` only (`:104-115` skips `.test.ts`) — a new `*.test.ts` file cannot introduce an offender, and editing JSON under `.bober/` cannot either. **Unaffected.** If you append to `sprint-contract.test.ts` note it is also a `.test.ts` and therefore invisible to that scan.

### Features That Could Be Affected
- **Sprint 6 of this plan (rank-aware channel join)** — shares `src/pge/runtime/commit.ts`. This sprint touches neither. No overlap.
- **`bober_sprint` / `bober_eval` MCP tools** — share `listContracts`; count unchanged, so their settled lists are unchanged.
- **`clearContractsForSpec`** — would delete all four if `spec-20260604-docs-correction` were ever re-planned. Unchanged by this sprint (it reads only `specId`).

### Recommended Regression Checks
1. `npx vitest run src/mcp/tools/sprint-corpus.test.ts` — the only real-corpus test; must stay green.
2. `npx vitest run src/contracts/` — sprint 1's invariant plus the existing 318-line unit file plus your new guard.
3. Confirm the corpus count is unmoved:
   `node -e 'const {SprintContractSchema}=await import("./dist/contracts/sprint-contract.js");const fs=await import("node:fs/promises");const d=".bober/contracts";let ok=0;for(const f of (await fs.readdir(d)).filter(x=>x.endsWith(".json")))if(SprintContractSchema.safeParse(JSON.parse(await fs.readFile(d+"/"+f,"utf-8"))).success)ok++;console.log(ok)' --input-type=module`
   → must print **196** (unchanged; requires `npm run build` first).
4. `git diff --stat` — must show exactly 4 JSON files (1 line each) + 1 test file. If `.bober/specs/spec-20260604-docs-correction.json` appears, you violated scope.
5. `git diff .bober/contracts/` — every hunk must be `-  "status": "pending",` / `+  "status": "completed",` and nothing else (evaluatorNotes: *"Check nothing else in those four files changed"*). Watch JSON formatting: these files use 2-space indent and **inline arrays** (`"filesInScope": ["CHANGELOG.md", "package.json"]`). Do **not** reserialise with `JSON.stringify(x, null, 2)` — that reflows every array and blows criterion "nothing else changed". **Hand-edit the single line.**
6. `npm run typecheck && npm run typecheck:tests && npm run lint && npm run build`
7. `npx vitest run` — full suite (sc-2-5).
8. Golden gate per `definitionOfDone`: `npx vitest run src/pge/golden/`.

---

## 8. Implementation Sequence

1. **`.bober/contracts/sprint-spec-20260604-docs-correction-{1,2,3,4}.json`** — hand-edit the single `"status"` line in each to `"completed"`. Change nothing else; do not add `completedAt` (nonGoal 2).
   - Verify: `git diff .bober/contracts/ | grep -c '^[+-]'` → exactly `8` (4 files × 1 removed + 1 added). Then `git diff --stat` shows `4 files changed, 4 insertions(+), 4 deletions(-)`.
2. **Corpus scan helper** — add a pure `findIllegalStatuses(entries)` returning `[]` or `["<file>: <bad status>"]`, driven by `ContractStatusSchema.safeParse(entry.status)`. Do **not** use `SprintContractSchema` (§1.3).
   - Verify: it is a plain function taking in-memory data; it does not import `node:fs`.
3. **sc-2-2 + sc-2-4 — the real-corpus assertion** — `readdir(join(REPO_ROOT, ".bober", "contracts"))` in `beforeAll`, filter `.json`, `JSON.parse` each, feed `findIllegalStatuses`, `expect(illegal).toEqual([])`. Add a liveness assertion (`expect(entries.length).toBeGreaterThan(200)`; today it is 256).
   - Verify: it fails **before** step 1 is applied (stash the JSON edits, re-run, see 4 offenders named) and passes after.
4. **sc-2-3 — the mutation control** — (a) in-memory: feed a literal `[{file: "sprint-fake-1.json", status: "pending"}]` and assert it is reported; (b) temp copy: `mkdtemp(join(tmpdir(), "contracts-status-"))`, `copyFile` the real corpus in, rewrite one copy's `status` to `"pending"`, run the same directory-reading scan against the temp dir, assert exactly that file is reported. `rm(..., {recursive:true, force:true})` in `afterEach`.
   - Verify: no scratch file is ever written under the repo — `git status --porcelain` is clean of untracked files after the run.
5. **Commit message** — `bober(sprint-2): ...` per `.bober/principles.md`, with the sc-2-1 justification: history.jsonl:272 `plan-completed`, all five annotated tags at their named commits, `CHANGELOG.md:59`, `README.md:784`; the spec's `abandoned` = *superseded* (`abandonedReason`, history.jsonl:919), not *never run*; therefore `"completed"`.
6. **Full verification** — `npm run typecheck && npm run typecheck:tests && npm run lint && npm run build && npx vitest run`, plus regression checks 1-5 and 8 from §7.

---

## 9. Pitfalls & Warnings

- **Do NOT validate the four files against `SprintContractSchema`.** They fail on `successCriteria`, `nonGoals`, `stopConditions`, `definitionOfDone` regardless of status (§1.3, simulated). A whole-schema corpus test fails on 60/256 files and can only be greened by violating nonGoal 2. Validate the `status` field alone against `ContractStatusSchema`.
- **Do NOT reserialise the JSON.** `JSON.stringify(obj, null, 2)` reflows `"filesInScope": ["CHANGELOG.md", "package.json"]` onto four lines and rewrites the long `successCriteria` strings, exploding the diff and failing the evaluator's *"nothing else in those four files changed"*. Hand-edit one line per file.
- **Do NOT choose `"proposed"`.** The orchestrator's brief says the work was never carried out; that is false and the evidence is in §1.4. `"proposed"` would falsify the record the stopCondition exists to protect.
- **Do NOT choose `"passed"`.** It is semantically settled but collides with the root-cause pin at `src/mcp/tools/sprint-corpus.test.ts:62-71`.
- **Do NOT touch `.bober/specs/spec-20260604-docs-correction.json`.** `abandoned` is a legal `SpecStatusSchema` member (`src/contracts/spec.ts:34,42`) and is correct — the spec was superseded on 2026-07-14, *after* its sprints ran. Out of scope.
- **Do NOT add `completedAt`.** These files have no such key (§1.3). nonGoal 2 forbids adding one. Note also that 6 other corpus files fail schema *because* their `completedAt` is `null` and the schema field is `.optional()` not `.nullable()` (`src/contracts/sprint-contract.ts:201`) — a different bug, not yours.
- **`REPO_ROOT` depth.** From `src/contracts/` it is `"../../"` — **two** levels, not three. `src/mcp/tools/sprint-corpus.test.ts:31`'s three-`".."` form is correct for *its* depth. Copying it verbatim into `src/contracts/` points at the parent of the repo and `readdir` throws.
- **`npm run typecheck:tests` does not cover your file.** `tsconfig.test.json`'s `include` is `["src/seo/builder/**/*.ts"]` only. `npm run typecheck` (`tsc --noEmit` over `src/`) is the gate that will catch type errors in your test. Run both anyway (sc-2-5).
- **There is no `vitest.config.ts`.** Do not pass `--config`; it fails. Use `npx vitest run <path>`.
- **`listContracts` cannot see the offenders** — it is the very function that hides them (`src/state/sprint-state.ts:137-140`). Your guard must `readdir` + `JSON.parse` raw, not go through `listContracts`.
- **Do not hardcode `256` or `196`.** Use a `toBeGreaterThan` threshold for liveness; a new contract lands in this directory on nearly every sprint (sc-2-4's whole point).
- **Grep before assuming the offender set.** Measured today: `pending` × 4, `completed` × 219, `proposed` × 32, `in-progress` × 1 = 256. The four are the complete set — but the test must re-derive this at run time, never restate it.
