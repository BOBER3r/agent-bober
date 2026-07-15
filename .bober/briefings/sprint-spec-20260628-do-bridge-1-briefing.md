# Sprint Briefing: Promoter registry, FindingStore port, and `bober do --dry-run`

**Contract:** sprint-spec-20260628-do-bridge-1
**Generated:** 2026-06-29T00:00:00.000Z

> ADDITIVE-ONLY sprint. The ONLY existing-core edit permitted is registering the new command in `src/cli/index.ts`. Do NOT touch `src/hub/` (task-inbox / priority-hub) or `src/state/facts.ts`. Consume the `Finding` shape through the new `FindingStore` port only.
>
> HARD BOUNDARY (evaluator-checked): the `--dry-run` path must NEVER import or reach `execa`, `node:child_process`, or any `RunSpawner` -- that is Sprint 2. Do not even add the import to `do.ts`. Do not read/write/delete anything under `.bober/approvals/`.

---

## 1. Target Files

All new files live in a NEW `src/do-bridge/` directory (does not exist yet) plus `src/cli/commands/do.ts`. Only `src/cli/index.ts` is modified.

### src/do-bridge/types.ts (create)
Holds: `PromoterKey`, `PromotionRef`, `PromotionPlan`, `Promoter` interface, re-uses `FindingKind` from the hub. Import the canonical `Finding` type -- never redefine it.

- `Finding.kind` is the enum `["action","watch","risk","question"]` (finding.ts:14). `FindingKind = Finding["kind"]`.
- `Finding.domain` is a free `z.string().min(1)` (finding.ts:12) -- the coding promoter matches the literal values `"coding"` and `"projects"` (contract assumption 3).
- `Finding.promotesTo` is `z.string().optional()` (finding.ts:24) -- a string ref. This sprint defines `PromotionRef` (the concrete meaning of that string) and `PromotionPlan` (the rich object the promoter returns).
- Suggested shapes (from contract generatorNotes):
  - `PromoterKey = { domain: string; kind?: FindingKind }`
  - `PromotionPlan = { kind: "bober-run"; task: string; teamId?: string }` (`kind` is a discriminant so Sprint 2 can add more promotion kinds).
  - `PromotionRef` -- a stable string id for a planned/recorded promotion (the value later written to `Finding.promotesTo`). Keep it a plain string alias this sprint.
  - `Promoter = (finding: Finding) => PromotionPlan` (sync; no I/O in the promoter).

### src/do-bridge/registry.ts (create)
A `PromoterRegistry` modelled on the keyed-registry in `src/orchestrator/checkpoints/registry.ts:18-32`. `register(key: PromoterKey, p: Promoter)` and `resolve(key: PromoterKey): Promoter | undefined` with precedence domain+kind > domain-only > undefined.

### src/do-bridge/finding-port.ts (create)
- `interface FindingStore { readFinding(id: string): Promise<Finding | null> }` (read-only this sprint -- NO write method).
- `FactStoreFindingStore` adapter: wraps a `FactStore` and DELEGATES to `readFindings(store)` (finding-store.ts:45) rather than re-reading raw facts. See Section 2 "Adapter delegation".
- `InMemoryFindingStore` fake: backed by a `Map<string, Finding>`; exposes a `writes` counter/array that stays empty (the port has no write path) so tests assert zero mutation (sc-1-4).

### src/do-bridge/coding-promoter.ts (create)
`codingPromoter(finding: Finding): PromotionPlan` -> `{ kind: "bober-run", task, teamId? }`. `task` is a non-empty one-line `bober run` task derived from `finding.title` (optionally appending `finding.evidence` / `finding.tags`). `teamId` optional -- may be parsed from a `team:<id>` tag or left undefined (default team).

### src/cli/commands/do.ts (create)
A DI-core `runDo(...)` + a `registerDoCommand(program)` -- mirrors the `task.ts` DI-core/registration split (Section 2). Handler NEVER throws: set `process.exitCode = 1` and `return`.

### src/cli/index.ts (modify) -- the ONLY core edit
- Add an import next to the other command imports (around `src/cli/index.ts:36-44`): `import { registerDoCommand } from "./commands/do.js";`
- Add the registration call next to `registerTaskCommand(program)` (call-site `src/cli/index.ts:322`; `registerMemoryCommand` is at 316, `registerFactsCommand` at 319): `registerDoCommand(program);`

Test files to create alongside: `registry.test.ts`, `finding-port.test.ts`, `coding-promoter.test.ts`, `do.test.ts` (all `*.test.ts` collocated -- principles.md:20).

---

## 2. Patterns to Follow

### Pattern A -- Canonical Finding type (import, never redefine)
**Source:** `src/hub/finding.ts:10-27`
```ts
export const FindingSchema = z.object({
  id: z.string().min(1),
  domain: z.string().min(1),
  title: z.string().min(1),
  kind: z.enum(["action", "watch", "risk", "question"]),
  urgency: z.number().int().min(1).max(5),
  severity: z.number().int().min(1).max(5),
  evidence: z.array(z.string()),
  surfacedAt: z.string().datetime(),
  dueBy: z.string().datetime().optional(),
  tags: z.array(z.string()),
  estDurationMin: z.number().int().optional(),
  calendarSafeTitle: z.string().optional(),
  status: z.enum(["open", "in-progress", "snoozed", "done", "dropped"]),
  promotesTo: z.string().optional(),
});
export type Finding = z.infer<typeof FindingSchema>;
```
**Rule:** `import type { Finding } from "../hub/finding.js";` and derive `type FindingKind = Finding["kind"];`. The hub OWNS this schema -- do NOT create a do-bridge Finding type.

### Pattern B -- Keyed registry (model PromoterRegistry on this)
**Source:** `src/orchestrator/checkpoints/registry.ts:18-32`
```ts
const mechanisms = new Map<string, CheckpointMechanism>();

export function registerCheckpointMechanism(name: string, impl: CheckpointMechanism): void {
  mechanisms.set(name, impl);
}

export function getCheckpointMechanism(name: string): CheckpointMechanism {
  const impl = mechanisms.get(name);
  if (!impl) {
    throw new Error(`Unknown checkpoint mechanism: ${name}. ...`);
  }
  return impl;
}
```
**Rule:** Use a `Map<string, Promoter>` keyed by a serialized `PromoterKey`. `resolve()` tries the domain+kind key first, then the domain-only key, then returns `undefined` (do NOT throw -- sc-1-5 requires `resolve()` to return undefined for an unsupported domain; the CLI handler converts that to a non-zero exit). Suggested key serializer: `` `${domain} ${kind ?? ""}` `` so domain+kind and domain-only never collide. A `class PromoterRegistry` is fine (cleaner than a module-global Map for a registry the CLI builds per-invocation).

### Pattern C -- How findings are encoded in the FactStore (read side)
**Source:** `src/hub/finding-store.ts:45-49` (the read API the adapter MUST delegate to)
```ts
export function readFindings(store: FactStore): Finding[] {
  return store
    .getActiveFacts(HUB_SCOPE, undefined, "finding")
    .map((r) => FindingSchema.parse(JSON.parse(r.value) as unknown));
}
```
Write encoding task-inbox uses (context only -- DO NOT call write paths this sprint), `src/hub/finding-store.ts:17-36`: one fact per finding with `scope=HUB_SCOPE("hub")`, `subject=finding.id`, `predicate="finding"`, `value=JSON.stringify(finding)`.
- `HUB_SCOPE = "hub"` exported from `src/hub/finding-source.ts:8`.
- NO single-finding-by-id read API exists (verified: `readFinding` singular has zero hits in `src/`). The adapter must filter `readFindings`.

### Pattern D -- Adapter delegation (FactStore-backed FindingStore)
**Rule:** The adapter holds a `FactStore` and implements `readFinding(id)` by delegating to the hub's `readFindings`:
```ts
// FactStoreFindingStore.readFinding(id):
return readFindings(this.store).find((f) => f.id === id) ?? null;
```
Satisfies the contract directive: "If task-inbox already exposes a finding-read API when you build, delegate the adapter to it instead of reading facts directly." It does -- use `readFindings`. Do NOT call `store.getActiveFacts(...)` directly from do-bridge.

### Pattern E -- FactStore construction at the CLI boundary
**Source:** `src/cli/commands/task.ts:346-368` (the `task add` registration handler)
```ts
.action(async (text: string, opts: { domain?: string }) => {
  const projectRoot = await resolveRoot();
  try {
    const ns = await resolveDefaultNamespace(projectRoot);
    await ensureFactsDir(projectRoot, ns);
    const now = new Date().toISOString();          // clock stamped at boundary only
    const store = new FactStore(factsDbPath(projectRoot, ns));
    try {
      await runTaskAdd(store, text, opts, now);     // DI core
    } finally {
      store.close();                                // always close
    }
  } catch (err) {
    process.stderr.write(chalk.red(`task add failed: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
  }
});
```
**Rule:** `do.ts`'s registration handler resolves root + namespace, calls `ensureFactsDir`, opens `new FactStore(factsDbPath(projectRoot, ns))`, wraps it in `FactStoreFindingStore`, builds the `PromoterRegistry`, registers `codingPromoter`, calls DI core `runDo(...)`, and closes the store in `finally`. The DI core takes a `FindingStore` (not a raw FactStore) so `do.test.ts` injects `InMemoryFindingStore`. Copy `resolveRoot` (task.ts:44-47) and `resolveDefaultNamespace` (task.ts:56-65) into `do.ts`.

### Pattern F -- DI core + handler-never-throws
**Source:** `src/cli/commands/task.ts:76-101` (`runTaskAdd`) and `src/cli/commands/approve.ts:44-52`
```ts
// approve.ts -- exitCode + return on the guard branch (never throw):
const exists = await pendingExists(projectRoot, checkpointId);
if (!exists) {
  process.stderr.write(chalk.red(`No pending checkpoint found: ${checkpointId}\n`) + ...);
  process.exitCode = 1;
  return;
}
```
**Rule:** Every failure branch in `runDo` is `process.stderr.write(chalk.red(...))` + `process.exitCode = 1` + `return`. Success writes `process.stdout.write(chalk.green(...))`. Use `chalk` and `import type { Command } from "commander";` like every sibling command. `runDo` resolution branches:
1. `finding === null` -> stderr "no finding with id ..." + exitCode 1 + return.
2. `registry.resolve({domain, kind}) === undefined` -> stderr naming the unsupported domain (sc-1-5) + exitCode 1 + return.
3. `--dry-run` -> build `plan = promoter(finding)`; print ONE stdout line containing `plan.task` AND the word `dry-run` (sc-1-4) plus the target `teamId` ("default team" when undefined); return. NO writes.
4. non-dry-run (Sprint 2 territory) -> print a notice that real launch is not implemented yet (Sprint 2) and return -- must NOT spawn anything. Keep `--dry-run` the documented path.

---

## 3. Existing Utilities -- DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `Finding` / `FindingSchema` | `src/hub/finding.ts:10,27` | Zod object / `z.infer` | Canonical finding type -- import, never redefine. |
| `readFindings` | `src/hub/finding-store.ts:45` | `(store: FactStore): Finding[]` | Read all active hub findings; the adapter delegates here. |
| `HUB_SCOPE` | `src/hub/finding-source.ts:8` | `const = "hub"` | FactStore scope for findings. |
| `FactStore` | `src/state/facts.ts:136` | `new FactStore(dbPath, opts?)` | SQLite-backed bi-temporal store (sync). |
| `FactStore#getActiveFacts` | `src/state/facts.ts:226` | `(scope, subject?, predicate?): FactRecord[]` | Underlying read (use via `readFindings`, not directly). |
| `factsDbPath` | `src/state/facts.ts:77` | `(projectRoot, namespace?): string` | Absolute path to `facts.db`. |
| `ensureFactsDir` | `src/state/facts.ts:86` | `(projectRoot, namespace?): Promise<void>` | mkdir the memory dir before opening a file-backed store. |
| `findProjectRoot` | `src/utils/fs.ts:58` | `(): Promise<string \| null>` | Walk upward to the project root. |
| `loadConfig` | `src/config/loader.ts:142` | `(projectRoot): Promise<BoberConfig>` | Load bober config (namespace/team). |
| `loadTeam` | `src/teams/registry.ts:35` | `(config, teamId?): Team` | Resolve a team; `Team.id` is `string` (teams/types.ts:22). |
| `captureTask` | `src/hub/task-inbox.ts:22` | `(store, text, {domain?, now}): Promise<Finding>` | Test-fixture helper to seed a Finding into a FactStore. |
| `chalk` | npm: chalk | -- | Colored CLI output (green=success, red=error, yellow=warn). |

**Utilities reviewed:** `src/utils/`, `src/state/`, `src/hub/`, `src/teams/`, `src/config/`. No existing promoter, do-bridge, or single-finding-by-id utility exists -- those are net-new this sprint.

---

## 4. Prior Sprint Output

### spec-20260628-priority-hub (OWNS the Finding schema)
**Created:** `src/hub/finding.ts` -- exports `FindingSchema`, `Finding`. **Connection:** import `Finding`/`FindingKind` from here; give `Finding.promotesTo` (finding.ts:24) its concrete meaning via `PromotionRef`/`PromotionPlan`. Do NOT modify finding.ts.

### spec-20260628-task-inbox (persists Findings on the FactStore)
**Created:** `src/hub/finding-store.ts` -- exports `writeFinding`, `readFindings` (finding-store.ts:45), `transitionFinding`, `ingestFinding`; `src/hub/task-inbox.ts` -- exports `captureTask` (task-inbox.ts:22); `src/cli/commands/task.ts`. **Connection:** findings stored as facts (`scope="hub"`, `predicate="finding"`, `subject=id`, `value=JSON`). The adapter reads them via `readFindings`. The `task.ts` DI-core/registration split + FactStore open/close-in-finally is the template for `do.ts`. Do NOT modify task-inbox.

---

## 5. Relevant Documentation

### Project Principles (.bober/principles.md)
- ESM everywhere -- all imports use `.js` extensions for NodeNext (principles.md:27). e.g. `"../hub/finding.js"`, `"../state/facts.js"`, `"./commands/do.js"`.
- `import type` for types -- ESLint `consistent-type-imports` is enforced (principles.md:35). e.g. `import type { Finding } from "../hub/finding.js";`, `import type { Command } from "commander";`.
- Zod for validation (principles.md:29) -- if you add a schema for `PromotionPlan`, use Zod; plain TS types are fine for internal-only shapes.
- Unicode section comments (principles.md:32) -- every sibling file uses box-drawing headers (finding.ts:3, facts.ts:16, task.ts:42). Follow this style in all new files.
- Small single-purpose modules (principles.md:33) -- types / registry / finding-port / coding-promoter are separate files (matches estimatedFiles).
- CLI handlers MUST NOT throw -- set `process.exitCode=1` and return (memory.ts:11-12 docstring, approve.ts pattern).
- No sync fs (principles.md:42) -- use `node:fs/promises`. `ensureFactsDir` handles dir creation.
- No `any` without justification (principles.md:40) -- use `unknown` + narrowing.
- Strict tsc (principles.md:18) -- `noUnusedLocals`/`noUnusedParameters`; prefix intentionally-unused params with `_`.

### Architecture Decisions
No `.bober/architecture/` ADR specific to do-bridge was found relevant. The keyed-registry convention is documented inline at `registry.ts:9-17` (mirrors `ROLE_TOOLS` in `src/orchestrator/tools/index.ts`).

---

## 6. Testing Patterns

**Runner:** Vitest. **Assertion style:** `expect(...)`. **Mock approach:** `vi.spyOn(process.stdout/stderr, "write")` to capture output; no fs mocks -- use a real in-memory `FactStore(":memory:")` or the `InMemoryFindingStore` fake. **File naming:** `*.test.ts` collocated (principles.md:20).

### Unit Test Pattern -- in-memory FactStore + stdout capture + exitCode reset
**Source:** `src/cli/commands/task.test.ts:1-87`
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FactStore } from "../../state/facts.js";

const T = "2026-06-28T00:00:00.000Z";
const originalExitCode = process.exitCode;
beforeEach(() => { process.exitCode = 0; });
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode as number | undefined;
});

it("success prints captured task id to stdout", async () => {
  const store = new FactStore(":memory:");
  const writes: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { writes.push(String(chunk)); return true; });
  await runTaskAdd(store, "renew passport", {}, T);
  expect(writes.join("")).toMatch(/Captured task/);
  store.close();
});
```
**Rule for `do.test.ts` (sc-1-4):** build an `InMemoryFindingStore` seeded with one coding Finding, capture stdout, call `runDo(store, registry, findingId, { dryRun: true })`, assert output contains the resolved task string AND `dry-run`, and assert `store.writes` (the fake's write counter) is empty. For sc-1-5: register only the coding promoter, feed a Finding whose domain has no promoter, assert `process.exitCode === 1` and stderr names the domain (capture `process.stderr.write`).

### Seeding a Finding fixture in a test (FactStore-backed path)
**Source:** `src/hub/finding-store.test.ts:9-21` (literal Finding object) and `src/cli/commands/task.test.ts:98` (`captureTask` helper)
```ts
const SAMPLE_FINDING: Finding = {
  id: "abc123def456abc1", domain: "inbox", title: "renew passport",
  kind: "action", urgency: 3, severity: 1, evidence: [],
  surfacedAt: T, tags: [], status: "open",
};
// or, to seed a real store: await captureTask(store, "fix the build", { domain: "coding", now: T });
```
**Note:** `domain`, `urgency`, `severity`, `kind`, `status`, `evidence`, `tags`, `surfacedAt`, `title`, `id` are ALL required by `FindingSchema`. A coding fixture for sc-1-3 uses `domain: "coding", kind: "action"` and a concrete `title`.

### Registry resolution-precedence test
**Source:** `src/orchestrator/checkpoints/registry.test.ts:60-71`
```ts
it("per-checkpoint override beats mode default", () => {
  const config = { pipeline: { mode: "careful" as const, checkpointOverrides: { "post-research": "cli" } } };
  expect(resolveCheckpointMechanismName("post-research", config)).toBe("cli");   // specific
  expect(resolveCheckpointMechanismName("post-plan", config)).toBe("disk");      // fallback
});
```
**Rule for `registry.test.ts` (sc-1-2):** register a `{domain:"coding"}` promoter AND a `{domain:"coding", kind:"action"}` promoter; assert `resolve({domain:"coding", kind:"action"})` returns the domain+kind one, and `resolve({domain:"coding", kind:"watch"})` falls back to the domain-only one. Add sc-1-5: `resolve({domain:"medical"})` returns `undefined`.

### E2E Test Pattern
Not applicable -- no Playwright/`e2e/` in this CLI project. Tests are Vitest unit tests only.

---

## 7. Impact Analysis -- Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/index.ts` | the new `registerDoCommand` import/call | low | Add import (near line 36) + call (near line 322). Symmetric with the 20+ existing `register*Command` calls -- a typo'd import path is the only realistic break (tsc catches it). |
| (none else) | do-bridge is net-new and read-only | -- | Nothing imports `src/do-bridge/*` yet, so no downstream breakage. |

Every other artifact is brand-new and the sprint is read-only -- no existing modules import the changed targets beyond `cli/index.ts`.

### Existing Tests That Must Still Pass
- `src/cli/commands/task.test.ts` -- exercises the FactStore + `readFindings` path you consume read-only; must stay green (you do not touch finding-store.ts).
- `src/hub/finding-store.test.ts` -- verifies the `scope=hub`/`predicate=finding`/`subject=id`/JSON encoding the adapter relies on; must stay green.
- `src/hub/finding.test.ts` -- guards the canonical schema (incl. `promotesTo` optional); must stay green (do not edit finding.ts).
- `src/orchestrator/checkpoints/registry.test.ts` -- the pattern you copy; unaffected.
- Full suite (`npm test`) -- the new command registration must not collide with an existing `do` command (verified: none exists).

### Features That Could Be Affected
- task-inbox / priority-hub -- share the `Finding` shape and the `hub` FactStore scope. Verify (by NOT editing them) that `bober task add|list` and `bober hub` behavior is byte-identical. The adapter only READS via `readFindings`.
- Sprint 2 (real launch) -- will add the non-dry-run path + approve gate + spawner. Keep `runDo` shaped so a `dryRun:false` branch and a spawner dependency can be injected later without rewriting the DI core.

### Recommended Regression Checks
1. `npm run build` -- zero type errors (sc-1-1).
2. `npm test -- src/do-bridge src/cli/commands/do.test.ts` -- new tests pass (sc-1-2..1-5).
3. `npm test -- src/hub src/cli/commands/task.test.ts` -- prior hub/task tests unaffected.
4. `grep -rn "execa\|child_process\|RunSpawner" src/do-bridge src/cli/commands/do.ts` -> must return NOTHING (evaluator hard check: dry-run reaches no spawn).
5. `git status .bober/approvals/` after running the dry-run handler in a test -> no new files (sc-1-4 / non-goal).

---

## 8. Implementation Sequence

Dependency-ordered (types -> registry -> port -> promoter -> CLI -> registration -> tests interleaved):

1. **src/do-bridge/types.ts** -- define `FindingKind`, `PromoterKey`, `PromotionRef`, `PromotionPlan`, `Promoter`. Import `Finding` from `../hub/finding.js`.
   - Verify: `npx tsc --noEmit` resolves the `Finding` import via the `.js` extension.
2. **src/do-bridge/registry.ts** -- `PromoterRegistry` with `register` + `resolve` (domain+kind > domain-only > undefined). No throw in `resolve`.
   - Verify: `resolve` returns `undefined` (not throw) for an unregistered domain.
3. **src/do-bridge/registry.test.ts** -- sc-1-2 precedence + sc-1-5 undefined.
   - Verify: `npm test -- src/do-bridge/registry.test.ts` green.
4. **src/do-bridge/finding-port.ts** -- `FindingStore` interface + `FactStoreFindingStore` (delegates to `readFindings`, finding-store.ts:45) + `InMemoryFindingStore` fake (Map + empty `writes` tracker).
   - Verify: adapter `readFinding(unknownId)` returns `null`; fake returns seeded finding.
5. **src/do-bridge/finding-port.test.ts** -- seed via `captureTask` or `writeFinding` into a `:memory:` FactStore, assert the adapter reads it back; assert the fake records zero writes.
6. **src/do-bridge/coding-promoter.ts** -- `codingPromoter(finding)` -> `{ kind:"bober-run", task, teamId? }`; non-empty `task` from title (+ evidence/tags).
   - Verify: returns `kind==="bober-run"` and a non-empty `task`.
7. **src/do-bridge/coding-promoter.test.ts** -- sc-1-3.
8. **src/cli/commands/do.ts** -- `runDo(store: FindingStore, registry, findingId, opts)` DI core (handler-never-throws) + `registerDoCommand(program)` that builds the FactStore-backed store + registry and adds the `do <findingId>` command with `--dry-run`. NO execa/child_process import.
9. **src/cli/commands/do.test.ts** -- sc-1-4 (dry-run prints task + "dry-run", fake records zero writes) + sc-1-5 (unsupported domain -> exitCode 1 naming domain).
10. **src/cli/index.ts** -- add the import (~line 36) and `registerDoCommand(program);` (~line 322, next to `registerTaskCommand`).
11. **Run full verification** -- `npm run build` && `npm test -- src/do-bridge src/cli/commands/do.test.ts` && the Section 7 grep/approvals regression checks.

---

## 9. Pitfalls & Warnings

- NEVER import `execa` / `node:child_process` / a spawner in `do.ts` or any do-bridge file. The evaluator greps for this. Real launch is Sprint 2. The dry-run path only reads + prints.
- Do NOT touch `.bober/approvals/`. No read/write/delete. sc-1-4 asserts no file appears there.
- `resolve()` returns `undefined`, it does NOT throw for an unsupported domain (unlike `getCheckpointMechanism` at registry.ts:24-31 which throws). sc-1-5 depends on the undefined return; the CLI handler turns that into `process.exitCode=1` + a domain-naming error.
- `Finding.domain` is a free string, not an enum. Match `"coding"`/`"projects"` as literals in the coding promoter; do not assume a closed domain enum.
- `.js` import extensions are mandatory (NodeNext). `import { Finding } from "../hub/finding"` (no `.js`) will compile-fail. Use `"../hub/finding.js"`.
- `import type` for type-only imports -- `consistent-type-imports` errors otherwise. `Finding`, `Command`, `FindingStore`, `Promoter`, `PromotionPlan` are type-only at most call sites.
- Do not redefine `Finding`. finding.ts:5-9 explicitly forbids it ("Do NOT redefine Finding anywhere else"). There is also a separate `Finding` in `src/medical/analysis/finding.ts` -- a DIFFERENT module; import from `../hub/finding.js`, NOT the medical one.
- There is no single-finding read API. Do not invent `readFinding` on the hub -- delegate to `readFindings(store).find(...)` inside the adapter.
- Close the FactStore in `finally` (task.ts:357-359 pattern) -- an unclosed better-sqlite3 handle leaks across tests.
- Stamp the clock at the CLI boundary only (`new Date().toISOString()` in the handler), never inside the DI core or promoter -- all prior modules are PURE w.r.t. the clock. A read-only dry-run may not need `now` at all; if it does, inject it.
- `process.exitCode` test hygiene: reset it in `beforeEach`/`afterEach` (task.test.ts:17-26) so an exitCode set by one test does not bleed into the next.
- Registration call-site line moves as code is added; anchor on `registerTaskCommand(program);` (currently line 322), not a hardcoded line number.
