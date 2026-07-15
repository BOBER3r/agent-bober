# Sprint Briefing: Canonical Finding schema, FactStore finding source, and `bober hub list`

**Contract:** sprint-spec-20260628-priority-hub-1
**Generated:** 2026-06-28T00:00:00Z

---

## 0. TL;DR for the Generator

Build a brand-new `src/hub/` module (no existing dir). Three production files + three tests + one wiring edit:

1. `src/hub/finding.ts` — `FindingSchema` (Zod) + `Finding` type. Field set is LOCKED (see §6).
2. `src/hub/finding-source.ts` — `FindingSource` interface `{ read(): Finding[] }` + `FactStoreFindingSource` that reads predicate-`finding` rows from a `FactStore`, JSON-parses each `value`, `safeParse`s, collects successes, skips failures (no throw).
3. `src/cli/commands/hub.ts` — `registerHubCommand(program)` + an exported DI core `runHubList(source)` so the test can drive it against a seeded in-memory store. Mirror `facts list` / `blackboard read` discipline (never throw, `process.exitCode = 1` on error, `store.close()` in `finally`).
4. `src/cli/index.ts` — register the command next to the other `register*Command` calls.

The FactStore convention you reuse: findings live as rows at `predicate: "finding"` with the serialized Finding as the `value`, exactly like `SharedBlackboard.publish` (`src/fleet/shared-blackboard.ts:80-90`). Read path is `getActiveFacts(scope, undefined, "finding")` (`src/state/facts.ts:222`).

---

## 1. Target Files

### `src/hub/finding.ts` (create)

**Directory pattern:** `src/hub/` does NOT exist yet — you create it. Module files in this project are kebab-case `.ts` (e.g. `shared-blackboard.ts`, `finding-source.ts`), tests collocated as `*.test.ts` (principles.md:20). Section comments use unicode box headers `// ── Name ──` (principles.md:32).

**Most similar existing file:** `src/medical/profile.ts:14-26` — a small Zod schema module that exports `Schema` + `z.infer` type. Follow this exact shape.

**Structure template (based on `src/medical/profile.ts:11-26`):**
```ts
import { z } from "zod";

// ── Schema ──────────────────────────────────────────────────────────

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
**Rule:** This is the SINGLE source of the Finding schema (nonGoals: "Do not redefine the Finding schema anywhere outside src/hub/finding.ts"). Siblings import from here. Do NOT add `.default([])` to `evidence`/`tags` unless you also want the test's "fully-populated valid finding" to round-trip — the locked set has them as required arrays; keep them `z.array(z.string())` (required) to match sc-1-1's plain `evidence (string[])`, `tags (string[])`.

---

### `src/hub/finding-source.ts` (create)

**Most similar existing file:** `src/fleet/shared-blackboard.ts:96-105` (`readAll`/`readSiblings` — how you call `getActiveFacts(...,"finding")`), combined with the `safeParse`-and-skip discipline from `FactStore.insertFact` (`src/state/facts.ts:173-180`).

**Structure template:**
```ts
import { FindingSchema } from "./finding.js";
import type { Finding } from "./finding.js";
import type { FactStore } from "../state/facts.js";

// ── Constants ───────────────────────────────────────────────────────

/** FactStore scope/namespace the hub stores its own findings under. */
export const HUB_SCOPE = "hub";

// ── FindingSource ───────────────────────────────────────────────────

export interface FindingSource {
  read(): Finding[];
}

/** Reads predicate-'finding' rows from one FactStore, parsing each into a Finding. */
export class FactStoreFindingSource implements FindingSource {
  constructor(
    private readonly store: FactStore,
    private readonly scope: string = HUB_SCOPE,
  ) {}

  read(): Finding[] {
    const rows = this.store.getActiveFacts(this.scope, undefined, "finding");
    const findings: Finding[] = [];
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.value);
      } catch {
        continue; // malformed JSON value — skip, never throw (sc-1-3)
      }
      const result = FindingSchema.safeParse(parsed);
      if (result.success) findings.push(result.data);
      // schema-invalid value — skip silently
    }
    return findings;
  }
}
```
**Rule:** Use `import type { FactStore }` (consistent-type-imports is enforced — principles.md:35). `JSON.parse` MUST be wrapped in its own try/catch (sc-1-3: skip a malformed-JSON row without throwing). Then `safeParse` and only push `result.success` rows.

---

### `src/cli/commands/hub.ts` (create)

**Most similar existing files:** `src/cli/commands/facts.ts:146-200` (the `facts list` subcommand — opens `new FactStore(factsDbPath(projectRoot, ns))`, reads, prints, `store.close()` in finally) and `src/cli/commands/blackboard.ts:90-151` (exported DI core + `register*Command`).

**Structure template:**
```ts
/**
 * `bober hub list` — print findings held in the project's own FactStore.
 * Error handling: handlers MUST NOT throw. Set process.exitCode=1 and return.
 * Pattern mirrors src/cli/commands/facts.ts.
 */
import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { loadConfig } from "../../config/loader.js";
import { loadTeam } from "../../teams/registry.js";
import { FactStore, factsDbPath, ensureFactsDir } from "../../state/facts.js";
import { FactStoreFindingSource, HUB_SCOPE } from "../../hub/finding-source.js";
import type { FindingSource } from "../../hub/finding-source.js";

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

async function resolveDefaultNamespace(projectRoot: string): Promise<string | undefined> {
  try {
    const config = await loadConfig(projectRoot);
    return loadTeam(config, undefined).memoryNamespace || undefined;
  } catch {
    return undefined;
  }
}

/** Pure-ish DI core: prints findings from an injected source. Testable in-memory. */
export function runHubList(source: FindingSource): void {
  const findings = source.read();
  if (findings.length === 0) {
    process.stdout.write(chalk.gray("No findings found.\n"));
    return;
  }
  for (const f of findings) {
    process.stdout.write(
      `${f.title}  [${f.kind}]  urgency=${f.urgency}  severity=${f.severity}\n`,
    );
  }
}

export function registerHubCommand(program: Command): void {
  const hubCmd = program
    .command("hub")
    .description("Unified cross-domain priority hub (list findings)");

  hubCmd
    .command("list")
    .description("Print findings held in the project's own FactStore")
    .action(async () => {
      const projectRoot = await resolveRoot();
      try {
        const ns = await resolveDefaultNamespace(projectRoot);
        await ensureFactsDir(projectRoot, ns);
        const store = new FactStore(factsDbPath(projectRoot, ns));
        try {
          runHubList(new FactStoreFindingSource(store, HUB_SCOPE));
        } finally {
          store.close();
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(`Failed to list findings: ${err instanceof Error ? err.message : String(err)}\n`),
        );
        process.exitCode = 1;
      }
    });
}
```
**Rule:** Exporting `runHubList(source)` is what makes sc-1-4 testable without spawning a CLI — the test seeds an in-memory `FactStore`, wraps it in `FactStoreFindingSource`, spies on `process.stdout.write`, and calls `runHubList`. The printed line MUST contain title, kind, urgency, and severity (sc-1-4).

---

## 2. Patterns to Follow

### Pattern A — Zod schema module (enum / int range / datetime / optional)
**Source:** `src/medical/profile.ts:16-26`, `src/config/schema.ts:84,188`, `src/state/facts.ts:22-31`
```ts
// src/medical/profile.ts:16-24
export const ProfileSchema = z.object({
  age: z.number().int().min(0),
  sex: z.enum(["male", "female", "other"]),
  conditions: z.array(z.string()).default([]),
  ...
});
export type Profile = z.infer<typeof ProfileSchema>;
```
```ts
// src/state/facts.ts:29-30 — ISO datetime fields
  tValid: z.string().datetime(),
  tCreated: z.string().datetime(),
```
**Rule:** `z.number().int().min(1).max(5)` for urgency/severity; `z.enum([...])` for kind/status; `z.string().datetime()` for surfacedAt/dueBy; `.optional()` for dueBy/estDurationMin/calendarSafeTitle/promotesTo. Always export `type X = z.infer<typeof XSchema>`.

### Pattern B — safeParse-and-skip (no throw on bad input)
**Source:** `src/state/facts.ts:173-181`
```ts
const result = FactSchema.safeParse(input);
if (!result.success) {
  const issues = result.error.issues.map((i) => ...).join("\n");
  throw new Error(`Invalid fact input:\n${issues}`);
}
const data = result.data;
```
**Rule:** The store version THROWS; your `FactStoreFindingSource.read()` must instead `continue`/skip on `!result.success` (sc-1-3 requires no throw). Use the `safeParse` → `result.success` branch but skip instead of throw.

### Pattern C — Reading predicate-'finding' facts
**Source:** `src/fleet/shared-blackboard.ts:102-105`
```ts
readAll(): FactRecord[] {
  return this.store.getActiveFacts(this.namespace, undefined, "finding");
}
```
**Rule:** Reuse this exact call shape with `HUB_SCOPE` in place of `this.namespace`. `getActiveFacts(scope, undefined, "finding")` is the canonical read path (`src/state/facts.ts:241-249` handles the predicate-only branch).

### Pattern D — CLI command: exported DI core + register function + never-throw handler
**Source:** `src/cli/commands/blackboard.ts:90-151`, `src/cli/commands/facts.ts:159-200`
```ts
// blackboard.ts:131-151 — register shape
export function registerBlackboardCommand(program: Command): void {
  const bbCmd = program.command("blackboard").description("...");
  bbCmd.command("read").option("--all", "...").action(async (opts) => {
    await runBlackboardRead(await resolveRoot(), opts);
  });
}
```
```ts
// facts.ts:160-195 — open store, read, print, close in finally
const store = new FactStore(factsDbPath(projectRoot, ns));
try {
  const records = store.getActiveFacts(opts.scope, opts.subject, opts.predicate);
  ...
} finally {
  store.close();
}
```
**Rule:** `try { ... } catch (err) { process.stderr.write(chalk.red(...)); process.exitCode = 1; }` — handlers NEVER throw. Always close the store in `finally`.

### Pattern E — CLI handler boilerplate (root + namespace resolvers)
**Source:** `src/cli/commands/facts.ts:27-50` (copy `resolveRoot` + `resolveDefaultNamespace` verbatim)
**Rule:** Reuse `findProjectRoot` (from `../../utils/fs.js`), `loadConfig` (`../../config/loader.js`), `loadTeam` (`../../teams/registry.js`), `factsDbPath`/`ensureFactsDir`/`FactStore` (`../../state/facts.js`). Do NOT re-implement path resolution.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `FactStore` | `src/state/facts.ts:136` | `new FactStore(dbPath: string, opts?)` | SQLite-backed bi-temporal fact store; the source's backing store. |
| `FactStore.getActiveFacts` | `src/state/facts.ts:222` | `(scope, subject?, predicate?): FactRecord[]` | The read path — call with `(HUB_SCOPE, undefined, "finding")`. |
| `FactStore.insertFact` | `src/state/facts.ts:173` | `(input: FactInput): FactRecord` | Seed findings in tests (predicate `"finding"`, value = `JSON.stringify(finding)`). |
| `factsDbPath` | `src/state/facts.ts:77` | `(projectRoot, namespace?): string` | Resolve the project's facts.db absolute path. |
| `ensureFactsDir` | `src/state/facts.ts:86` | `(projectRoot, namespace?): Promise<void>` | Ensure the memory dir exists before opening a file-backed store. |
| `FactRecord` (type) | `src/state/facts.ts:37` | interface | The row shape returned by `getActiveFacts`; `.value` holds the JSON. |
| `findProjectRoot` | `src/utils/fs.ts` (imported at `facts.ts:17`) | `(): Promise<string \| undefined>` | Walk up to the project root. |
| `loadConfig` | `src/config/loader.ts` (imported at `facts.ts:18`) | `(projectRoot): Promise<Config>` | Load bober.config.json. |
| `loadTeam` | `src/teams/registry.ts` (imported at `facts.ts:19`) | `(config, name?) -> { memoryNamespace }` | Resolve the active memory namespace. |
| `ensureDir` | `src/utils/fs.ts` / re-exported `src/state/helpers.ts` (used `shared-blackboard.ts:3`) | `(dir): Promise<void>` | Async mkdir -p. |
| `SharedBlackboard` | `src/fleet/shared-blackboard.ts:38` | class | REFERENCE ONLY for the predicate-'finding' convention — do NOT import it into the hub. |

Utilities reviewed: `src/utils/` (`fs.ts`, logger, git), `src/state/` (facts, helpers, memory), `src/config/`. No existing Finding schema or finding-parsing util exists anywhere (`grep` for `FindingSchema`/`FindingSource` returns nothing) — you are creating these for the first time.

---

## 4. Prior Sprint Output

No prior sprints completed in this spec (`dependsOn: []`). This is the foundational vertical slice. Downstream sprints (per contract `outOfScope`) will import `FindingSchema`/`Finding` from `src/hub/finding.ts` and `FindingSource` from `src/hub/finding-source.ts`:
- Sprint 2: cross-repo collector + sibling resolution + dedup (imports `Finding`).
- Sprint 3: scope parsing + lens judge + ranking.
- Sprint 4: `priority.md` + `decide`.
- Sprint 5: chat hub surface.

Design implication: keep `FindingSchema`, `Finding`, `FindingSource`, and `FactStoreFindingSource` cleanly exported — they are the public seams future sprints depend on.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere — all relative imports use `.js` extensions** (line 27). e.g. `from "./finding.js"`, `from "../state/facts.js"`.
- **Zod for validation; no hand-rolled validation** (line 29).
- **`import type { ... }` enforced** by `consistent-type-imports` (line 35) — type-only imports (`Finding`, `FactStore`, `Command`, `FindingSource`) MUST use `import type`.
- **No synchronous fs** (line 42) — use `node:fs/promises`; `ensureFactsDir` is already async.
- **Tests collocated as `*.test.ts`, Vitest** (line 20).
- **Section comments** with box-drawing headers (line 32).
- **No `any`** — use `unknown` + narrowing (line 40). `JSON.parse` returns `any`; type the local as `unknown` then `safeParse`.
- **Conventional commits**: sprint commits use `bober(sprint-N): description` (line 34).
- **Strict TS**: `noUnusedLocals`/`noUnusedParameters` on (line 18) — prefix unused params with `_`.

### Architecture Decisions
No `.bober/architecture/` ADR specific to the hub was found for this spec. The locked hub design lives in research, not an ADR — see §6.

### Other Docs — Locked hub design
`.bober/research/research-20260627-knowledge-platform-landscape.md:107-135` — "Unified hub — detailed design". Key locked rules: the hub OWNS the Finding schema; priority is query-scoped (NOT this sprint); findings ride on existing FactStore machinery. The canonical field set is at lines 121-126 (see §6).

---

## 6. The Locked Finding Field Set (reconcile research:121-126 with contract sc-1-1)

**research-20260627-knowledge-platform-landscape.md:122-126:**
```
Finding { id, domain, title, kind: action|watch|risk|question,
  urgency 1-5, severity 1-5, evidence[], surfacedAt, dueBy?,
  tags[], estDurationMin?, calendarSafeTitle?, status, promotesTo? }
```

**Reconciled with contract sc-1-1 (which fixes the exact Zod types/enums):**

| Field | Type | Required? | Notes |
|-------|------|-----------|-------|
| `id` | `z.string()` | yes | |
| `domain` | `z.string()` | yes | |
| `title` | `z.string()` | yes | |
| `kind` | `z.enum(["action","watch","risk","question"])` | yes | rejects `"todo"` (sc-1-2) |
| `urgency` | `z.number().int().min(1).max(5)` | yes | rejects `6` (sc-1-2) |
| `severity` | `z.number().int().min(1).max(5)` | yes | |
| `evidence` | `z.array(z.string())` | yes | |
| `surfacedAt` | `z.string().datetime()` | yes | ISO |
| `dueBy` | `z.string().datetime().optional()` | no | ISO |
| `tags` | `z.array(z.string())` | yes | |
| `estDurationMin` | `z.number().int().optional()` | no | |
| `calendarSafeTitle` | `z.string().optional()` | no | |
| `status` | `z.enum(["open","in-progress","snoozed","done","dropped"])` | yes | enum from sc-1-1 (research lists `status` un-enumerated; sc-1-1 + research:131 lifecycle pin the values) |
| `promotesTo` | `z.string().optional()` | no | |

The two sources are fully consistent — sc-1-1 only ADDS the enum/int precision that research left implicit. No conflict.

---

## 7. Testing Patterns

### Unit test — schema + source (`src/hub/finding.test.ts`, `src/hub/finding-source.test.ts`)
**Source pattern:** `src/state/facts.test.ts:1-34` (in-memory FactStore, no temp dir needed)
```ts
import { describe, it, expect } from "vitest";
import { FactStore } from "../state/facts.js";
import { FactStoreFindingSource, HUB_SCOPE } from "./finding-source.js";
import { FindingSchema } from "./finding.js";

// finding.test.ts — sc-1-2
it("rejects urgency 6", () => {
  const bad = { /* valid finding */ urgency: 6 };
  expect(FindingSchema.safeParse(bad).success).toBe(false);
});
it("rejects kind 'todo'", () => {
  expect(FindingSchema.safeParse({ /* ... */ kind: "todo" }).success).toBe(false);
});
it("accepts a fully-populated valid finding", () => {
  expect(FindingSchema.safeParse(VALID_FINDING).success).toBe(true);
});

// finding-source.test.ts — sc-1-3 (seed via insertFact, predicate "finding")
it("returns valid findings and skips a malformed-JSON row", () => {
  const store = new FactStore(":memory:");
  const t = "2026-06-28T00:00:00.000Z";
  store.insertFact({ scope: HUB_SCOPE, subject: "f1", predicate: "finding",
    value: JSON.stringify(VALID_FINDING), confidence: 1, sourceRunId: null, tValid: t, tCreated: t });
  store.insertFact({ scope: HUB_SCOPE, subject: "f2", predicate: "finding",
    value: "{not json", confidence: 1, sourceRunId: null, tValid: t, tCreated: t });
  const got = new FactStoreFindingSource(store, HUB_SCOPE).read();
  expect(got).toHaveLength(1);
  store.close();
});
```
**Runner:** vitest 3.x. **Assertion style:** `expect(...)`. **Mock approach:** none for schema/source — use real in-memory `FactStore(":memory:")`. **File naming:** `*.test.ts` collocated. **Note:** `insertFact` requires `value` length ≥ 1 (`FactSchema` at `facts.ts:26`) — a `"{not json"` value satisfies that and exercises the JSON-parse skip path.

### Unit test — CLI (`src/cli/commands/hub.test.ts`)
**Source pattern:** `src/cli/commands/blackboard.test.ts:7-29, 146-160` (stdout spy + `process.exitCode` lifecycle)
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FactStore } from "../../state/facts.js";
import { FactStoreFindingSource, HUB_SCOPE } from "../../hub/finding-source.js";
import { runHubList } from "./hub.js";

const originalExitCode = process.exitCode;
beforeEach(() => { process.exitCode = 0; });
afterEach(() => { vi.restoreAllMocks(); process.exitCode = originalExitCode as number | undefined; });

it("prints two findings with title/kind/urgency/severity (sc-1-4)", () => {
  const store = new FactStore(":memory:");
  const t = "2026-06-28T00:00:00.000Z";
  for (const f of [FINDING_A, FINDING_B]) {
    store.insertFact({ scope: HUB_SCOPE, subject: f.id, predicate: "finding",
      value: JSON.stringify(f), confidence: 1, sourceRunId: null, tValid: t, tCreated: t });
  }
  const writes: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((d: unknown) => { writes.push(String(d)); return true; });
  runHubList(new FactStoreFindingSource(store, HUB_SCOPE));
  const out = writes.join("");
  expect(out).toContain(FINDING_A.title);
  expect(out).toContain(FINDING_B.title);
  expect(out).toContain(String(FINDING_A.urgency));
  store.close();
});
```
**Selector convention / E2E:** No Playwright in this project (CLI tool — principles.md:48 "no user interface"). E2E pattern not applicable; the CLI DI-core test above is the integration surface.

---

## 8. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/index.ts` | adds `registerHubCommand` import + call | low | Build only — additive import + one `registerHubCommand(program)` line. Don't reorder existing registrations. |
| `src/state/facts.ts` | NOT modified (nonGoal: do not modify FactStore constructor) | none | Import only; do not edit. |
| `src/fleet/shared-blackboard.ts` | reference only | none | Do not import or edit; it is the convention example. |

The new `src/hub/` files have NO existing dependents (the module is new), so nothing downstream can break this sprint. The only edited existing file is `src/cli/index.ts`.

### Existing Tests That Must Still Pass
- `src/state/facts.test.ts` — covers `FactStore`/`getActiveFacts`/`insertFact`; your code only READS via these. Verify still green (you don't touch facts.ts).
- `src/fleet/shared-blackboard.test.ts` — covers the predicate-'finding' convention you mirror; must stay green (you don't touch shared-blackboard.ts).
- `src/cli/commands/blackboard.test.ts`, `src/cli/commands/memory.test.ts` — sibling CLI command tests; adding a new command + registration must not affect them. Re-run the CLI command test suite.
- The full suite (currently ~3142 tests per project memory) must remain green; you add new hub tests, change no behavior of existing modules.

### Features That Could Be Affected
- **Fleet blackboard** — shares the predicate-`finding` FactStore convention. You read with a different `scope` (`"hub"`) so namespaces are isolated (`getActiveFacts` filters by scope — `facts.ts:222`). Verify hub reads do not pick up fleet-namespace findings (different scope = isolated).
- **`bober facts` / `bober memory`** — share `FactStore` + `factsDbPath` + namespace resolution. Adding `hub list` must not alter their output.

### Recommended Regression Checks
1. `npm run build` — zero TS errors (sc-1-5; also the contract's build verification).
2. `npm run typecheck` — `tsc --noEmit` clean (catches missing `.js` extensions / type-import violations).
3. `npx vitest run src/hub src/cli/commands/hub.test.ts` — the new tests pass.
4. `npx vitest run src/state/facts.test.ts src/fleet/shared-blackboard.test.ts src/cli/commands/blackboard.test.ts` — no regression in the modules/conventions you reuse.
5. `npm run lint` (optional but cheap) — `eslint src/` confirms `consistent-type-imports` compliance.

---

## 9. Implementation Sequence

1. **`src/hub/finding.ts`** — define `FindingSchema` (locked field set, §6) + `export type Finding`.
   - Verify: `npm run typecheck` clean for the new file; mentally check each field type against the §6 table.
2. **`src/hub/finding.test.ts`** — sc-1-2: rejects `urgency: 6`, rejects `kind: "todo"`, accepts a fully-populated valid finding.
   - Verify: `npx vitest run src/hub/finding.test.ts` green.
3. **`src/hub/finding-source.ts`** — `HUB_SCOPE` constant, `FindingSource` interface, `FactStoreFindingSource` (read → getActiveFacts → JSON.parse try/catch → safeParse → collect successes).
   - Verify: imports use `import type { FactStore }` and `from "./finding.js"`.
4. **`src/hub/finding-source.test.ts`** — sc-1-3: seed valid + malformed-JSON + (optionally) schema-invalid rows; assert only the valid one returns and no throw.
   - Verify: `npx vitest run src/hub/finding-source.test.ts` green.
5. **`src/cli/commands/hub.ts`** — `runHubList(source)` DI core + `registerHubCommand(program)` (mirror `facts list` store open/close + `blackboard` never-throw discipline).
   - Verify: handler wraps everything in try/catch with `process.exitCode = 1`; store closed in `finally`.
6. **`src/cli/commands/hub.test.ts`** — sc-1-4: seed two findings in an in-memory store, spy on stdout, call `runHubList`, assert both titles + a kind/urgency/severity appear.
   - Verify: `npx vitest run src/cli/commands/hub.test.ts` green.
7. **`src/cli/index.ts`** — add `import { registerHubCommand } from "./commands/hub.js";` near line 42 and `registerHubCommand(program);` in the registration block (next to `registerBlackboardCommand(program)` around line 332, before the `program.parseAsync` call at line 335).
   - Verify: registration is added BEFORE `await program.parseAsync(process.argv)` (`index.ts:335`).
8. **Run full verification** — `npm run build` (sc-1-5), `npm run typecheck`, then `npx vitest run src/hub src/cli/commands/hub.test.ts` and the regression set from §8.

---

## 10. Pitfalls & Warnings

- **`.js` extensions are mandatory** on every relative import (ESM/NodeNext). `from "./finding"` will NOT compile — must be `from "./finding.js"`. (principles.md:27)
- **`import type` for type-only imports** — `Finding`, `FactStore`, `Command`, `FindingSource`, `FactRecord` must be `import type`; mixing them into a value import will fail `consistent-type-imports` lint. (principles.md:35)
- **Wrap `JSON.parse` in its own try/catch** — a malformed value must `continue`, not bubble. sc-1-3 explicitly tests "skips a row with a malformed JSON value without throwing". Do NOT rely on `safeParse` to catch a JSON syntax error — `JSON.parse` throws *before* safeParse runs.
- **Do NOT modify `FactStore` / `src/state/facts.ts`** — nonGoal + assumption ("Do not modify the FactStore constructor"). Read only.
- **Do NOT redefine the Finding schema anywhere else** — single definition in `src/hub/finding.ts` (nonGoal; evaluatorNotes verifies "no second definition exists"). Don't add a parallel interface in finding-source.ts; import the `z.infer` type.
- **`insertFact` requires non-empty `value`** (`FactSchema` `value: z.string().min(1)`, `facts.ts:26`) — your malformed-JSON test fixture must be a non-empty non-JSON string like `"{not json"`, not `""`.
- **Scope isolation** — read with `getActiveFacts(HUB_SCOPE, undefined, "finding")`. If you accidentally pass the fleet namespace or omit the scope you'll cross-read other modules' findings.
- **`runHubList` must be exported** — without the DI core export, sc-1-4 can only be tested by spawning the real CLI, which is brittle. Export it like `blackboard.ts` exports `runBlackboardRead`.
- **Register before `parseAsync`** — the `registerHubCommand(program)` call must sit in the block ending at `src/cli/index.ts:332`, before `await program.parseAsync(process.argv)` at line 335. Don't append after parse.
- **`process.exitCode` in tests** — follow the blackboard test lifecycle (save/restore `process.exitCode`, `vi.restoreAllMocks()` in `afterEach`) so the stdout spy and exit code don't leak across tests.
