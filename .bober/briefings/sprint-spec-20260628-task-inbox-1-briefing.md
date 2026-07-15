# Sprint Briefing: Zero-friction task capture — persistence helper + `bober task add`

**Contract:** sprint-spec-20260628-task-inbox-1
**Generated:** 2026-06-29T00:00:00Z

---

## 0. TL;DR for the Generator (read first)

You are mirroring two existing files almost verbatim:
- **`src/cli/commands/facts.ts`** — the CLI command shape (parent + subcommand, now-at-boundary, try/catch→exitCode, FactStore open/close).
- **`src/hub/finding-source.ts`** — the existing Finding↔FactStore reader (`FactStoreFindingSource`) and the `HUB_SCOPE = "hub"` constant. **A Finding READER already exists. You are adding the WRITER.**

THREE CORRECTIONS to the generatorNotes you MUST apply:
1. The runtime Zod schema is named **`FindingSchema`** (src/hub/finding.ts:10), NOT `Finding`. `Finding` is a **type only** (src/hub/finding.ts:27). Use `FindingSchema.parse(...)`, never `Finding.parse(...)`.
2. The hub Finding module does **NOT** export `FindingKind`/`FindingStatus`. Those exist only in an unrelated module (`src/medical/analysis/finding.ts:26,29`) with a DIFFERENT status enum. **Do not import them.** The hub kind/status are inline `z.enum`s inside `FindingSchema`.
3. `domain` is a **REQUIRED, min(1)** field on FindingSchema (src/hub/finding.ts:12). You CANNOT leave it null. `urgency`/`severity` are also **required ints 1–5** (lines 15–16). "Leave unknown fields null" applies only to the genuinely optional fields: `dueBy`, `estDurationMin`, `calendarSafeTitle`, `promotesTo` (lines 19,21,22,24) — omit those.

---

## 1. Target Files

### src/hub/finding.ts (READ-ONLY — import from here, never redefine)

The canonical schema. Full file is only 28 lines. Exact exports and field optionality:

```ts
export const FindingSchema = z.object({
  id: z.string().min(1),                                  // REQUIRED
  domain: z.string().min(1),                              // REQUIRED min(1) — cannot be ""/null
  title: z.string().min(1),                               // REQUIRED min(1)
  kind: z.enum(["action", "watch", "risk", "question"]),  // REQUIRED — set "action"
  urgency: z.number().int().min(1).max(5),                // REQUIRED int — set neutral 3
  severity: z.number().int().min(1).max(5),               // REQUIRED int — set neutral 1
  evidence: z.array(z.string()),                          // REQUIRED — set []
  surfacedAt: z.string().datetime(),                      // REQUIRED — set now (ISO)
  dueBy: z.string().datetime().optional(),                // OPTIONAL — omit
  tags: z.array(z.string()),                              // REQUIRED — set [] or ["domain:"+d]
  estDurationMin: z.number().int().optional(),            // OPTIONAL — omit
  calendarSafeTitle: z.string().optional(),               // OPTIONAL — omit
  status: z.enum(["open","in-progress","snoozed","done","dropped"]), // REQUIRED — set "open"
  promotesTo: z.string().optional(),                      // OPTIONAL — omit
});
export type Finding = z.infer<typeof FindingSchema>;
```

**Exports:** `FindingSchema` (value, src/hub/finding.ts:10) and `Finding` (type, line 27). Nothing else.
**Import in new files:** `import { FindingSchema } from "./finding.js";` + `import type { Finding } from "./finding.js";`

---

### src/hub/finding-store.ts (create)

**Directory pattern:** `src/hub/` uses kebab-case-free single-word/compound lowercase names (`finding.ts`, `finding-source.ts`, `repo-resolver.ts`, `hub-config.ts`); tests are collocated `*.test.ts`.
**Most similar existing file:** `src/hub/finding-source.ts` (the READER). Mirror its imports/constants. You are adding the WRITER + a thin reader.

**What it must export:**
- `writeFinding(store: FactStore, finding: Finding, opts: { now: string }): Promise<ReconcileAction>` — serialize to a `FactInput` and route through **`writeFact`** (NOT raw `insertFact`).
- `readFindings(store: FactStore): Finding[]` — `getActiveFacts(HUB_SCOPE, undefined, "finding").map(r => FindingSchema.parse(JSON.parse(r.value)))`.

**Structure template (build from finding-source.ts + facts.ts patterns):**
```ts
import { FindingSchema } from "./finding.js";
import type { Finding } from "./finding.js";
import { HUB_SCOPE } from "./finding-source.js";          // reuse "hub" — DO NOT re-declare
import { FactStore, writeFact } from "../state/facts.js"; // writeFact is re-exported here (facts.ts:13)
import type { ReconcileAction } from "../state/facts.js";

export async function writeFinding(
  store: FactStore,
  finding: Finding,
  { now }: { now: string },
): Promise<ReconcileAction> {
  return writeFact(
    store,
    {
      scope: HUB_SCOPE,
      subject: finding.id,
      predicate: "finding",
      value: JSON.stringify(finding),
      confidence: 1,
      sourceRunId: null,
      tValid: now,
      tCreated: now,
    },
    { now },
  );
}

export function readFindings(store: FactStore): Finding[] {
  return store
    .getActiveFacts(HUB_SCOPE, undefined, "finding")
    .map((r) => FindingSchema.parse(JSON.parse(r.value)));
}
```
**Note on `readFindings` vs existing reader:** `FactStoreFindingSource.read()` (src/hub/finding-source.ts:26-51) already reads the exact same rows but uses `safeParse` + skip-on-malformed. `readFindings` here uses `.parse` (throws on bad rows) per generatorNotes. Both are acceptable; keep `readFindings` minimal. Do NOT duplicate the `HUB_SCOPE` constant — import it from `finding-source.js`.

---

### src/hub/task-inbox.ts (create)

**Exports:** `captureTask(store: FactStore, text: string, opts: { domain?: string; now: string }): Promise<ReconcileAction>` (or `Finding` — pick one, keep tests consistent). It builds a Finding then calls `writeFinding`.

**Structure template:**
```ts
import { createHash } from "node:crypto";       // node:crypto already used in src/state/facts.ts:2
import type { Finding } from "./finding.js";
import { FactStore } from "../state/facts.js";
import { writeFinding } from "./finding-store.js";

const DEFAULT_DOMAIN = "inbox";                  // domain is REQUIRED min(1) — neutral default

export async function captureTask(
  store: FactStore,
  text: string,
  { domain, now }: { domain?: string; now: string },
): Promise<Finding> {
  const title = text.trim();
  // stable deterministic id (no clock call here — `now` is injected)
  const id = createHash("sha256").update(`${title}|${now}`).digest("hex").slice(0, 16);
  const finding: Finding = {
    id,
    domain: domain ?? DEFAULT_DOMAIN,            // REQUIRED — cannot be empty
    title,
    kind: "action",
    urgency: 3,                                  // neutral default (contract assumption §3a)
    severity: 1,                                 // neutral default
    evidence: [],
    surfacedAt: now,
    tags: domain ? [`domain:${domain}`] : [],    // generatorNotes: domain → tag
    status: "open",
    // dueBy / estDurationMin / calendarSafeTitle / promotesTo: OMITTED (optional)
  };
  await writeFinding(store, finding, { now });
  return finding;
}
```
**sc-1-4 reconciliation:** "no domain tag" when `--domain` absent → `tags === []` (and `domain` field falls back to `DEFAULT_DOMAIN`). "carries that domain" with `--domain medical` → assert BOTH `finding.domain === "medical"` AND/OR `finding.tags.includes("domain:medical")`. The test is yours to write — make it match what `captureTask` does above.
**NO `new Date()`/`Date.now()` in this file** (nonGoals + principles). `now` is always injected.

---

### src/cli/commands/task.ts (create)

**Most similar existing files:** `src/cli/commands/facts.ts:54-144` (the `add` subcommand) and `src/cli/commands/hub.ts:106-202` (the DI-core + register split that makes handlers unit-testable).

**Mirror these helpers verbatim from facts.ts:29-50 / hub.ts:39-60:** `resolveRoot()` and `resolveDefaultNamespace(projectRoot)`.

**Export a DI core (so sc-1-5 can unit-test it without spawning the CLI), e.g.:**
```ts
export async function runTaskAdd(
  store: FactStore,
  text: string,
  opts: { domain?: string },
  now: string,
): Promise<void> {
  const title = text.trim();
  if (title.length === 0) {                       // empty-input guard — mirrors hub.ts:257-266
    process.stderr.write(chalk.red("task add: text must not be empty\n"));
    process.exitCode = 1;
    return;
  }
  try {
    const finding = await captureTask(store, title, { domain: opts.domain, now });
    process.stdout.write(chalk.green(`Captured task ${chalk.bold(finding.id)}\n`));
    process.stdout.write(`  title:  ${finding.title}\n`);
    process.stdout.write(`  domain: ${finding.domain}\n`);
  } catch (err) {
    process.stderr.write(
      chalk.red(`Failed to add task: ${err instanceof Error ? err.message : String(err)}\n`),
    );
    process.exitCode = 1;
  }
}
```

**Then `registerTaskCommand(program)` opens the store + stamps now at the boundary** (copy facts.ts:80-134):
```ts
export function registerTaskCommand(program: Command): void {
  const taskCmd = program.command("task").description("Personal task inbox (capture tasks as hub findings)");
  taskCmd
    .command("add <text>")
    .description("Capture a plain task into the unified hub pool")
    .option("--domain <domain>", "Optional domain tag (e.g. medical)")
    .action(async (text: string, opts: { domain?: string }) => {
      const projectRoot = await resolveRoot();
      try {
        const ns = await resolveDefaultNamespace(projectRoot);
        await ensureFactsDir(projectRoot, ns);
        const now = new Date().toISOString();          // STAMP HERE — boundary only (facts.ts:86)
        const store = new FactStore(factsDbPath(projectRoot, ns));
        try {
          await runTaskAdd(store, text, opts, now);
        } finally {
          store.close();                                // always close (facts.ts:132-134)
        }
      } catch (err) {
        process.stderr.write(chalk.red(`task add failed: ${err instanceof Error ? err.message : String(err)}\n`));
        process.exitCode = 1;
      }
    });
}
```
**Imports needed:** `chalk` (default), `import type { Command } from "commander";`, `{ findProjectRoot } from "../../utils/fs.js"`, `{ loadConfig } from "../../config/loader.js"`, `{ loadTeam } from "../../teams/registry.js"`, `{ FactStore, factsDbPath, ensureFactsDir } from "../../state/facts.js"`, `{ captureTask } from "../../hub/task-inbox.js"`.

---

### src/cli/index.ts (modify — add ONE import + ONE call)

**Import block (insert next to line 37 `registerFactsCommand`):**
```ts
import { registerFactsCommand } from "./commands/facts.js";   // line 37 (existing)
import { registerTaskCommand } from "./commands/task.js";     // ADD
```
**Registration (insert next to line 318 `registerFactsCommand(program)`):**
```ts
  // ── facts ──
  registerFactsCommand(program);   // line 318 (existing)
  // ── task ──
  registerTaskCommand(program);    // ADD
```
That is the ONLY change to this file. Do not touch any other registration.

---

## 2. Patterns to Follow

### Pattern: now-at-handler-boundary (PURE store)
**Source:** `src/cli/commands/facts.ts`, line 86
```ts
// Stamp wall-clock time at handler boundary — NEVER inside the store
const now = new Date().toISOString();
```
**Rule:** `new Date()`/`Date.now()` may appear ONLY in `registerTaskCommand`'s action. `finding-store.ts`, `task-inbox.ts`, and the store itself must receive `now` as a parameter.

### Pattern: never-throw CLI handler → process.exitCode
**Source:** `src/cli/commands/facts.ts`, lines 135-142
```ts
} catch (err) {
  process.stderr.write(
    chalk.red(`Failed to add fact: ${err instanceof Error ? err.message : String(err)}\n`),
  );
  process.exitCode = 1;
}
```
**Rule:** Handlers set `process.exitCode = 1` + write to stderr; they NEVER `throw`. Success leaves exitCode at its default 0.

### Pattern: FactStore open at boundary, always close in `finally`
**Source:** `src/cli/commands/facts.ts`, lines 99-134 (and hub.ts:174-193)
```ts
const store = new FactStore(factsDbPath(projectRoot, ns));
try {
  const action = await writeFact(store, input, { now });
  ...
} finally {
  store.close();
}
```
**Rule:** Construct the store with `factsDbPath(projectRoot, ns)`, wrap work in try/finally, always `store.close()`.

### Pattern: persist a Finding as a FactInput row (scope/subject/predicate/value)
**Source:** `src/hub/finding-source.test.ts`, lines 27-37 (seedFact) and `src/cli/commands/hub.test.ts`, lines 63-72 (seedRepo)
```ts
store.insertFact({
  scope: HUB_SCOPE, subject: f.id, predicate: "finding",
  value: JSON.stringify(f), confidence: 1, sourceRunId: null,
  tValid: T, tCreated: T,
});
```
**Rule:** A Finding lives in the pool as `scope="hub"`, `subject=finding.id`, `predicate="finding"`, `value=JSON.stringify(finding)`. Your `writeFinding` builds the SAME shape but passes it to `writeFact` (so reconcile/dedup runs), not `insertFact`.

### Pattern: route writes through writeFact (dedup/supersede)
**Source:** `src/cli/commands/facts.ts`, line 103; impl `src/orchestrator/memory/reconcile.ts`, lines 148-154
```ts
const action = await writeFact(store, input, { now });   // returns "add"|"update"|"noop"
```
**Rule:** `writeFact` is async and re-exported from `src/state/facts.ts:13` (import it from `../state/facts.js`). Use it, NOT `store.insertFact`, so later sprints' dedup works. `ReconcileAction` is a re-exported type (facts.ts:14).

### Pattern: DI-core + register split (testable handler)
**Source:** `src/hub/../cli/commands/hub.ts`, lines 106-117 (runHubList) vs 159-202 (registerHubCommand)
```ts
export function runHubList(source: FindingSource): void { ... }   // unit-tested directly
// register wires FactStore + boundary, then calls the core
```
**Rule:** Export a pure-ish core (`runTaskAdd`) that takes an already-open store + injected `now`; the registered action handles root/ns/store/now and delegates. This is how the existing hub tests reach exit-code behavior without commander.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `writeFact` | `src/orchestrator/memory/reconcile.ts:148` (re-exported `src/state/facts.ts:13`) | `(store, FactInput, {judge?, now}) => Promise<ReconcileAction>` | Reconcile-then-write; dedup/supersede. **Use this, not insertFact.** |
| `ReconcileAction` | `src/state/facts.ts:14` (type) | `"add"\|"update"\|"delete"\|"noop"` | Return type of writeFinding. |
| `FactStore` | `src/state/facts.ts:136` | `new FactStore(dbPath, opts?)` | SQLite-backed store; `":memory:"` for tests. |
| `FactStore.getActiveFacts` | `src/state/facts.ts:226` | `(scope, subject?, predicate?) => FactRecord[]` | Read active rows; `getActiveFacts("hub", undefined, "finding")`. |
| `FactInput` | `src/state/facts.ts:33` (type) | `{scope,subject,predicate,value,confidence,sourceRunId,tValid,tCreated}` | Shape writeFinding serializes into. |
| `factsDbPath` | `src/state/facts.ts:77` | `(projectRoot, namespace?) => string` | Absolute path to facts.db. |
| `ensureFactsDir` | `src/state/facts.ts:86` | `(projectRoot, namespace?) => Promise<void>` | mkdir before opening a file-backed store. Not needed for `:memory:`. |
| `factId` | `src/state/facts.ts:58` | `(scope,subject,predicate,value,tCreated) => string` | Deterministic 16-hex id (reference for id-derivation style; uses createHash). |
| `FindingSchema` | `src/hub/finding.ts:10` | Zod schema | Parse/validate Findings. **The runtime export is `FindingSchema`, NOT `Finding`.** |
| `Finding` | `src/hub/finding.ts:27` | type | `z.infer<typeof FindingSchema>`. |
| `HUB_SCOPE` | `src/hub/finding-source.ts:8` | `"hub"` | The pool scope constant. Import, do not hardcode. |
| `FactStoreFindingSource` | `src/hub/finding-source.ts:26` | `class implements FindingSource` | Existing safeParse+skip reader of hub findings (your `readFindings` overlaps it). |
| `findProjectRoot` | `src/utils/fs.js` (used `facts.ts:30`) | `() => Promise<string\|undefined>` | Locate `.bober` root for resolveRoot(). |
| `loadConfig` | `src/config/loader.js` (used `facts.ts:18`) | `(projectRoot) => Promise<Config>` | For resolveDefaultNamespace. |
| `loadTeam` | `src/teams/registry.js` (used `facts.ts:19`) | `(config, id?) => Team` | `.memoryNamespace` for namespace resolution. |
| `createHash` | `node:crypto` (used `src/state/facts.ts:2`) | stdlib | Stable id derivation in task-inbox.ts. |

Utilities reviewed in `utils/`, `lib/`, `helpers/`, `shared/`, `common/`: only `src/utils/fs.ts` (`findProjectRoot`) is relevant; the rest (git/logger/etc.) are not used by this sprint.

---

## 4. Prior Sprint Output

### Dependency spec-20260628-priority-hub (COMPLETE) — owns the Finding pool
**Created:** `src/hub/finding.ts` — exports `FindingSchema` (value) + `Finding` (type). **No FindingKind/FindingStatus exports.**
**Created:** `src/hub/finding-source.ts` — exports `HUB_SCOPE = "hub"` and `FactStoreFindingSource` (the reader) + `FindingSource` interface.
**Created:** `src/hub/{collector,scope,judge,priority-md,hub-config,repo-resolver}.ts` — ranking/render pipeline (out of scope here).
**Connection to this sprint:** task-inbox writes Findings into the SAME pool (`scope="hub"`, `predicate="finding"`) that `hub list`/`hub priority` already read. After `bober task add`, the new row is immediately visible to `bober hub list` (src/cli/commands/hub.ts:177 reads `new FactStoreFindingSource(store, HUB_SCOPE).read()`). Reuse `HUB_SCOPE`; never redefine the schema.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** — all relative imports MUST use `.js` extensions (line 27). e.g. `./finding.js`, `../state/facts.js`.
- **`import type { ... }`** — ESLint `consistent-type-imports` is enforced (lines 19,35). Import `Finding`, `Command`, `ReconcileAction`, `FactInput` as types.
- **No synchronous fs** — use `node:fs/promises` only (line 42). (You only need `ensureFactsDir`, which already wraps this.)
- **Collocated tests** — `*.test.ts` next to `*.ts` with Vitest (line 20). `finding-store.test.ts`, `task-inbox.test.ts`, `task.test.ts` sit beside their sources.
- **Section comments** — use `// ── Section ──` box headers (line 32). See facts.ts / hub.ts.
- **Prefix unused params with `_`** (line 36); **no `any`** (line 40); **strict mode**, zero type/lint errors is a hard gate (lines 18-19).

### Architecture Decisions
`.bober/architecture/` exists (untracked) but contains no ADR relevant to task-inbox/Finding persistence. The relevant invariant is in-code: **FactStore is PURE — never reads the clock** (src/state/facts.ts:130). Honour it.

### Other Docs
No CONTRIBUTING.md guidance specific to this sprint. README not required reading here.

---

## 6. Testing Patterns

### Unit Test Pattern — in-memory FactStore
**Source:** `src/hub/finding-source.test.ts` and `src/state/facts.test.ts:17-34`
```ts
import { describe, it, expect } from "vitest";
import { FactStore } from "../state/facts.js";
import { HUB_SCOPE } from "./finding-source.js";

const T = "2026-06-28T00:00:00.000Z";   // injected `now`

it("captures one open action finding (sc-1-3)", async () => {
  const store = new FactStore(":memory:");          // no ensureFactsDir needed for :memory:
  await captureTask(store, "renew passport", { now: T });
  const rows = store.getActiveFacts(HUB_SCOPE, undefined, "finding");
  expect(rows).toHaveLength(1);
  const f = JSON.parse(rows[0]!.value);
  expect(f.kind).toBe("action");
  expect(f.status).toBe("open");
  expect(f.title).toBe("renew passport");
  expect(f.dueBy).toBeUndefined();                  // optional → omitted
  store.close();
});
```
**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** none for the store (real `:memory:` SQLite — principles line 44 forbids fs mocks). **File naming:** `*.test.ts`. **Location:** collocated.

### CLI exit-code test (sc-1-5) — spy stdout/stderr, manage process.exitCode
**Source:** `src/cli/commands/hub.test.ts`, lines 79-88 and 333-360
```ts
const originalExitCode = process.exitCode;
beforeEach(() => { process.exitCode = 0; });
afterEach(() => { vi.restoreAllMocks(); process.exitCode = originalExitCode as number | undefined; });

it("empty input → exitCode 1, no throw (sc-1-5)", async () => {
  const store = new FactStore(":memory:");
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await expect(runTaskAdd(store, "   ", {}, T)).resolves.toBeUndefined();  // never throws
  expect(process.exitCode).toBe(1);
  store.close();
});

it("valid input → exitCode stays 0", async () => {
  const store = new FactStore(":memory:");
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  await runTaskAdd(store, "renew passport", {}, T);
  expect(process.exitCode).toBe(0);
  store.close();
});
```
**Selector/spy convention:** `vi.spyOn(process.stdout, "write")` / `process.stderr`; collect writes via a pushed array if you need to assert content (hub.test.ts:108-113).

### E2E
Not applicable — no Playwright in this repo; CLI behavior is covered by the unit/handler tests above.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/index.ts` | (you add import + call) | low | One import at ~37, one `registerTaskCommand(program)` at ~318. Don't reorder/remove existing registrations. Build catches a bad import path. |
| `src/cli/commands/hub.ts` | hub pool (`scope=hub`/`predicate=finding`) | low | `hub list` reads the same rows your `writeFinding` writes — your rows must be schema-valid or `FactStoreFindingSource` silently skips them (finding-source.ts:43-47). |
| `src/state/facts.ts` consumers (facts.ts, blackboard, memory) | `FactStore`/`writeFact` (unchanged) | none | You only IMPORT these; you do not modify them. No regression surface. |

### Existing Tests That Must Still Pass
- `src/hub/finding.test.ts` — validates FindingSchema; your Findings must conform (domain min1, urgency/severity 1-5). If your captured Finding is invalid, it won't break this test but WILL fail your own readback.
- `src/hub/finding-source.test.ts` — reader contract; unchanged, must stay green.
- `src/cli/commands/hub.test.ts` — `hub list`/`priority` over the pool; unchanged, must stay green.
- `src/state/facts.test.ts` — FactStore/`:memory:` contract; unchanged, must stay green.
- Full suite (~3264 tests per project memory) must not regress.

### Features That Could Be Affected
- **hub list / priority / decide** (src/cli/commands/hub.ts) — share the `scope="hub"` pool. After this sprint, tasks captured via `bober task add` should appear in `bober hub list`. Verify a captured task is schema-valid so the hub reader includes it.

### Recommended Regression Checks
1. `npm run build` exits 0 (sc-1-1).
2. `npm run typecheck` exits 0 (sc-1-2) — confirms `FindingSchema`/`Finding` import type-checks against writeFinding/readFindings.
3. `npx vitest run src/hub/finding-store.test.ts src/hub/task-inbox.test.ts src/cli/commands/task.test.ts` — new tests pass.
4. `npx vitest run src/hub src/cli/commands/hub.test.ts src/state/facts.test.ts` — no regression in the pool/reader.
5. `npm run lint` (eslint src/) — zero errors (type imports, unused-`_`, no `any`).
6. Manual: `node dist/cli/index.js task add "renew passport"` exits 0; `node dist/cli/index.js hub list` shows the new open action finding.

---

## 8. Implementation Sequence

1. **`src/hub/finding-store.ts`** — `writeFinding` (routes through `writeFact`) + `readFindings` (FindingSchema.parse). Import `FindingSchema`, `Finding` type, `HUB_SCOPE`, `FactStore`, `writeFact`, `ReconcileAction` type.
   - Verify: `npm run typecheck` passes; no `Date`/`insertFact`/local `z.object` for Finding.
2. **`src/hub/task-inbox.ts`** — `captureTask` builds the Finding (kind=action/status=open/neutral urgency=3,severity=1/surfacedAt=now/tags from domain/domain field defaulted) and calls `writeFinding`. No clock call.
   - Verify: typecheck passes; grep the file for `new Date(` / `Date.now(` / `z.object` → must be ZERO.
3. **`src/hub/finding-store.test.ts`** — `:memory:` store, write→read roundtrip; one row; optional fields absent.
   - Verify: tests pass.
4. **`src/hub/task-inbox.test.ts`** — sc-1-3 (renew passport, injected now, one open action, dueBy absent) + sc-1-4 (no-domain → no domain tag; domain=medical → carries domain).
   - Verify: tests pass.
5. **`src/cli/commands/task.ts`** — `runTaskAdd` DI core (empty-input guard, try/catch→exitCode) + `registerTaskCommand` (resolveRoot/resolveDefaultNamespace/ensureFactsDir/now-at-boundary/FactStore try-finally).
   - Verify: typecheck passes.
6. **`src/cli/commands/task.test.ts`** — sc-1-5 exit-code behavior via `runTaskAdd` with `:memory:` store + stdout/stderr spies + exitCode lifecycle.
   - Verify: tests pass.
7. **`src/cli/index.ts`** — add `import { registerTaskCommand }` (~line 37) and `registerTaskCommand(program)` (~line 318).
   - Verify: `npm run build` exits 0.
8. **Run full verification** — `npm run build`, `npm run typecheck`, `npx vitest run`, `npm run lint`.

---

## 9. Pitfalls & Warnings

- **`FindingSchema` not `Finding` at runtime.** generatorNotes write `Finding.parse(...)` — that would be a compile error. The Zod value is `FindingSchema` (src/hub/finding.ts:10); `Finding` is type-only (line 27).
- **Do NOT import `FindingKind`/`FindingStatus`.** They exist ONLY in `src/medical/analysis/finding.ts:26,29` and describe a DIFFERENT Finding (status enum `open|resolved|dismissed`, not the hub's `open|in-progress|snoozed|done|dropped`). The hub schema has these as inline `z.enum`s; do not import a kind/status union from anywhere.
- **`domain` is REQUIRED `min(1)`** (src/hub/finding.ts:12). "Leave unknown fields null" does NOT apply — set `domain = optDomain ?? "inbox"` (or another neutral default). Same for `urgency`/`severity` (required ints; use neutral 3/1 per contract assumption §3a).
- **Only `dueBy`, `estDurationMin`, `calendarSafeTitle`, `promotesTo` are optional** (lines 19,21,22,24). OMIT them — do not set them to `null` (they are `.optional()`, i.e. `undefined`, not `nullable`; `JSON.stringify` drops undefined keys, which is what sc-1-3 expects for `dueBy`).
- **Route through `writeFact`, never `store.insertFact`** (evaluatorNotes). `writeFact` is async — `await` it and make `writeFinding` async.
- **No clock in `src/hub/*`.** `new Date().toISOString()` appears ONLY in `registerTaskCommand`'s action (src/cli/commands/facts.ts:86 is the reference). The store enforces purity (src/state/facts.ts:130).
- **Reuse `HUB_SCOPE` from `finding-source.ts:8`** — do not hardcode `"hub"` or declare a second constant.
- **`readFindings` overlaps `FactStoreFindingSource`.** Don't expand it into a second reader class; keep it the one-liner from generatorNotes. The existing reader uses `safeParse` (skips bad rows); `readFindings` uses `.parse` (throws) — acceptable divergence, just don't duplicate `HUB_SCOPE` or the row query logic into a new constant/helper.
- **Empty-input path is the sc-1-5 "error" case.** Guard `text.trim() === ""` → stderr + `process.exitCode = 1` + return (mirror hub.ts:257-266). Never `throw` out of the handler.
- **ESLint `consistent-type-imports`.** Import `Command`, `Finding`, `ReconcileAction`, `FactInput` with `import type`. A value/type mix-up is a hard lint failure.
- **`.js` extensions on every relative import** (NodeNext). `./finding.js`, `./finding-source.js`, `./finding-store.js`, `../state/facts.js`, `../../hub/task-inbox.js`.
- **`src/cli/index.ts` is the only `modify`** — keep the diff to two lines; do not reformat surrounding registrations.
