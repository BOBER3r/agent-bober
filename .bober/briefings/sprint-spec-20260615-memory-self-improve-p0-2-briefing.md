# Sprint Briefing: Reconcile-on-write — deterministic exact-match supersede + LLM-judged ambiguity

**Contract:** sprint-spec-20260615-memory-self-improve-p0-2
**Generated:** 2026-06-15T00:00:00.000Z

---

## 0. Sprint Goal (one paragraph)

Route all fact writes through a new PURE-CORE reconcile step. `reconcileFact(store, incoming, { judge?, now })` queries the active facts for the exact `(scope,subject,predicate)`, and decides: **NOOP** (same value), **UPDATE/supersede** (different value — invalidate old + insert new), or **ADD** (no exact match). When there is no exact match but a *normalized*-key collision exists among active facts (same subject/predicate after lowercase + strip-non-alphanumeric), it consults an injected `FactJudge` (ADD/UPDATE/DELETE/NOOP), falling back to **ADD** when no judge is given. The LLM `createLLMFactJudge()` lives in a separate file and is the ONLY place that touches `createClient` — and **never** on the exact-match path (sc-2-3/sc-2-4 must pass with zero LLM). Then `writeFact()` is added to `src/state/facts.ts` and the `bober facts add` CLI is rerouted through it so adds reconcile instead of duplicating.

---

## 1. Target Files

### src/orchestrator/memory/reconcile.ts (create) — PURE CORE

**Directory pattern:** Files in `src/orchestrator/memory/` are kebab-less single-word `.ts` modules (`distill.ts`, `retrieve.ts`, `eval-source.ts`), each with a co-located `.test.ts`. Each starts with a `/** PURE ... */` header block, then `// ── Section ──` banner comments (Constants / Types / Helpers / Core).

**Most similar existing file:** `src/orchestrator/memory/distill.ts` — same PURE / injected-clock discipline. Mirror its header, banner style, and the "never read the clock here" rule.

**Exports required (sc-2-2):**
- `type ReconcileAction = "add" | "update" | "delete" | "noop"` (lowercase string literals — confirmed by sc-2-2 and generatorNotes).
- `async function reconcileFact(store, incoming, { judge?, now }): Promise<ReconcileAction>` where `store: FactStore`, `incoming: FactInput`, `now: string` (ISO), `judge?: FactJudge`.

**Algorithm (from generatorNotes — implement exactly):**
1. `const active = store.getActiveFacts(incoming.scope, incoming.subject, incoming.predicate)` — exact key, active-only.
2. Exact match with SAME `value` exists → return `"noop"` (no insert, no invalidate).
3. Exact match (same scope/subject/predicate) with DIFFERENT `value` → UPDATE: `store.invalidateFact(old.id, now)`, then `store.insertFact(incoming)`, return `"update"`. (See §9 edge case on `t_invalid`.)
4. No exact match → AMBIGUITY check: normalize subject+predicate (lowercase + strip non-alphanumeric — inline the helper, see §2 Pattern A), scan active facts in the same scope (`store.getActiveFacts(incoming.scope)`) for one whose normalized `(subject,predicate)` equals the incoming's normalized key.
   - Found AND `judge` provided → `await judge.resolve(incoming, candidate)` → apply ADD/UPDATE/DELETE/NOOP.
   - Found but NO judge → deterministic fallback = ADD (insert + return `"add"`).
   - Not found → ADD.
5. DELETE = `store.invalidateFact(candidate.id, now)` WITHOUT inserting `incoming`; return `"delete"`.

**Structure template (based on distill.ts header + retrieve.ts helper):**
```typescript
/**
 * PURE deterministic reconcile-on-write for semantic facts.
 *
 * PURE — never reads the clock (now is injected), never calls createClient.
 * The injected FactJudge is the ONLY async/LLM surface and is consulted ONLY
 * on a deterministic normalized-key collision (the ambiguity branch).
 * Exact-match NOOP/UPDATE/ADD never touch the judge or the network.
 */
import type { FactStore, FactInput, FactRecord } from "../../state/facts.js";
import type { FactJudge } from "./fact-judge.js";

export type ReconcileAction = "add" | "update" | "delete" | "noop";

/** Lowercase + strip non-alphanumerics — mirrors tokenize() in retrieve.ts:30-35. */
function normalizeKey(subject: string, predicate: string): string {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return `${norm(subject)}|${norm(predicate)}`;
}

export async function reconcileFact(
  store: FactStore,
  incoming: FactInput,
  { judge, now }: { judge?: FactJudge; now: string },
): Promise<ReconcileAction> { /* ... algorithm above ... */ }
```

---

### src/orchestrator/memory/fact-judge.ts (create) — LLM surface (ONLY place that imports createClient)

**Most similar existing file:** `src/chat/turn-classifier.ts` — a single `LLMClient.chat()` call that returns a strict enum and **returns a FALLBACK on any parse error or throw, never propagates**. Mirror its `stripCodeFences` / `extractFirstObject` / `safeParse` / `try/catch → FALLBACK` shape exactly, but with the 4-value enum.

**Exports required (sc-2-5):**
- `interface FactJudge { resolve(incoming: FactInput, candidate: FactRecord): Promise<ReconcileAction> }`
- `function createLLMFactJudge(...): FactJudge` — builds a client via `createClient(...)` like `src/orchestrator/architect-agent.ts:195-201`.

**Critical rules:**
- Tiny prompt; instruct the model to return ONLY a JSON object like `{"action":"update"}` with action in `add|update|delete|noop`.
- Parse defensively (reuse turn-classifier helpers); on ANY parse failure or thrown error → return `"add"` (never let the LLM corrupt the store — evaluatorNotes).
- `BOBER_TEST_DETERMINISTIC=1` is honoured automatically because `createClient` short-circuits to a stub at `src/providers/factory.ts:182-184` — the stub returns text `"[BOBER_TEST_DETERMINISTIC] Stub response..."`, which is non-JSON, so the defensive parser falls through to `"add"`. No extra env check is needed inside fact-judge, but you MAY assert it. Do not call the network in tests.

**createClient build pattern to follow** (`architect-agent.ts:195-203`):
```typescript
const client = createClient(
  config.planner.provider ?? null,
  config.planner.endpoint ?? null,
  config.planner.providerConfig,
  config.planner.model,
  "FactJudge",          // role label for error messages
);
const model = resolveModel(config.planner.model);  // from "../model-resolver.js"
```
`createLLMFactJudge()` should accept the pieces it needs (or a `BoberConfig`) and store `{ client, model }`, mirroring `TurnClassifier`'s constructor (`turn-classifier.ts:126-133`). Keep its signature small; the contract only requires it exist and be createClient-backed.

---

### src/state/facts.ts (modify) — add writeFact wrapper

**Relevant existing surface (lines 27-43, 130-275) the wrapper depends on:**
- `FactInput` = `z.infer<typeof FactSchema>` (line 27): `{ scope, subject, predicate, value, confidence, sourceRunId, tValid, tCreated }`.
- `FactRecord` (lines 31-43): adds `id`, `tInvalid`, `tInvalidated`.
- `FactStore.insertFact(input): FactRecord` (line 158), `getActiveFacts(scope, subject?, predicate?): FactRecord[]` (line 207), `getFact(id): FactRecord | null` (line 248), `invalidateFact(id, tInvalidated): boolean` (line 260).
- `factId(scope, subject, predicate, value, tCreated): string` (line 52).

**Add (thin wrapper, delegates to reconcile — sc-2-2):**
```typescript
import { reconcileFact } from "../orchestrator/memory/reconcile.js";
import type { ReconcileAction } from "../orchestrator/memory/reconcile.js";
import type { FactJudge } from "../orchestrator/memory/fact-judge.js";

/**
 * Reconcile-then-write a fact. Wall-clock `now` is injected by the caller —
 * this function never reads the clock (mirrors the store's purity contract).
 */
export async function writeFact(
  store: FactStore,
  incoming: FactInput,
  opts: { judge?: FactJudge; now: string },
): Promise<ReconcileAction> {
  return reconcileFact(store, incoming, opts);
}
```
NOTE on import direction: facts.ts currently imports only `./helpers.js` and `./memory.js`. Adding an import from `../orchestrator/memory/reconcile.js` creates a state→orchestrator edge. If that cross-layer import is undesirable, the contract permits "a thin wrapper" — you may instead place `writeFact` in `src/orchestrator/memory/reconcile.ts` and have the CLI import it from there. **Prefer the path that keeps build/lint green;** the contract's sc-2-2 says "writeFact in the facts module delegates to it" so default to adding it to facts.ts unless a layering lint rule fires.

**Imported by (writeFact consumers after this sprint):** `src/cli/commands/facts.ts` (the `add` handler). The store class itself is imported by `facts.ts` CLI and `src/state/facts.test.ts`.

**Test file:** `src/state/facts.test.ts` — EXISTS (in-memory FactStore tests). Do not break these.

---

### src/cli/commands/facts.ts (modify) — route `add` through writeFact

**Relevant section (lines 84-98) — the current direct insert to replace:**
```typescript
// Stamp wall-clock time at handler boundary — NEVER inside the store
const now = new Date().toISOString();
const store = new FactStore(factsDbPath(projectRoot, ns));
try {
  const rec = store.insertFact({ scope: opts.scope, subject: opts.subject,
    predicate: opts.predicate, value: opts.value,
    confidence: Math.max(0, Math.min(1, Number(opts.confidence) || 1)),
    sourceRunId: opts.runId ?? null, tValid: now, tCreated: now });
  // ... prints rec.id, scope, subject, predicate, value, t_created
```
**Change:** keep `now = new Date().toISOString()` (clock stays at the CLI boundary), build the same `FactInput`, then call `const action = await writeFact(store, input, { now })` (no judge wired in the CLI for this sprint — deterministic add/supersede only). Adapt the success print: on `"noop"` print "unchanged", on `"update"` print "superseded", on `"add"` keep the "Added fact" message. The handler MUST NOT throw — keep the existing `try/catch → process.exitCode=1` (lines 110-117) and `finally { store.close() }` (lines 107-109).

---

## 2. Patterns to Follow

### Pattern A — Normalize/tokenize (lowercase + strip non-alphanumeric)
**Source:** `src/orchestrator/memory/retrieve.ts`, lines 30-35
```typescript
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}
```
**Rule:** `tokenize` is NOT exported (private to retrieve.ts) — do NOT try to import it. Inline an equivalent `normalizeKey` in reconcile.ts using the SAME lowercase + non-alphanumeric-strip logic (`s.toLowerCase().replace(/[^a-z0-9]+/g, "")`). This is the deterministic ambiguity key.

### Pattern B — Single-call enum-returning LLM helper with defensive fallback
**Source:** `src/chat/turn-classifier.ts`, lines 80-122 (parse) and 140-169 (call)
```typescript
async classify(input: string): Promise<ClassifierAction> {
  const system = [/* tiny instruction listing the allowed JSON shapes */].join("\n");
  try {
    const response = await this.llm.chat({
      model: this.model,
      system,
      messages: [{ role: "user", content: input }],
      jsonObjectMode: true,            // loose JSON mode for provider parity
    });
    return parseClassifierAction(response.text);  // returns FALLBACK on bad JSON
  } catch {
    return FALLBACK;                   // network/throw → FALLBACK, never propagate
  }
}
```
**Rule:** Mirror this exactly for `createLLMFactJudge().resolve()`. Use `jsonObjectMode: true`, a Zod enum (`z.enum(["add","update","delete","noop"])` inside `z.object({ action: ... })`), `stripCodeFences`/`extractFirstObject` (copy from turn-classifier.ts:53-74), `safeParse`, and `try/catch → "add"`. FALLBACK here is `"add"`, not `"answer"`.

### Pattern C — PURE core / injected clock discipline
**Source:** `src/orchestrator/memory/distill.ts`, lines 1-8, 34-38, 118-122
```typescript
/** PURE — must not import from ../providers; no network, no Date.now(), no side effects ... */
```
**Rule:** reconcile.ts must never call `Date.now()`/`new Date()` (use injected `now`) and must never import `../../providers/factory.js` (the judge owns that import). distill.test.ts:292-307 asserts the source contains no `Date.now()`/`new Date()`/`fetch(`/`createClient` — expect an analogous purity test on reconcile.ts.

### Pattern D — Zod-validate-then-act (already in the store)
**Source:** `src/state/facts.ts`, lines 158-166
```typescript
insertFact(input: FactInput): FactRecord {
  const result = FactSchema.safeParse(input);
  if (!result.success) { /* build message, throw */ }
  const data = result.data;  // ... insert
}
```
**Rule:** `insertFact` already validates with `FactSchema`. reconcileFact may pass `incoming` straight to `insertFact` and rely on that validation; do not re-validate redundantly. `confidence` defaults to 1 via the schema.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `FactStore` | `src/state/facts.ts:130` | `new FactStore(dbPath: string)` | Bi-temporal SQLite store; pass `":memory:"` in tests. |
| `FactStore.insertFact` | `src/state/facts.ts:158` | `(input: FactInput): FactRecord` | Validates + inserts; derives deterministic id. |
| `FactStore.getActiveFacts` | `src/state/facts.ts:207` | `(scope, subject?, predicate?): FactRecord[]` | Active (t_invalidated IS NULL) facts, exact-match filtered. |
| `FactStore.getFact` | `src/state/facts.ts:248` | `(id): FactRecord \| null` | Fetch by id regardless of invalidation (for assertions). |
| `FactStore.invalidateFact` | `src/state/facts.ts:260` | `(id, tInvalidated): boolean` | Soft-delete (sets t_invalidated); never deletes the row. |
| `factId` | `src/state/facts.ts:52` | `(scope,subject,predicate,value,tCreated): string` | Deterministic 16-char id; needed to assert/locate rows. |
| `FactSchema` / `FactInput` / `FactRecord` | `src/state/facts.ts:16,27,31` | Zod schema + types | The input/record shapes — import, don't redefine. |
| `factsDbPath` / `ensureFactsDir` | `src/state/facts.ts:71,80` | path/dir helpers | Used by the CLI (already wired). |
| `createClient` | `src/providers/factory.ts:172` | `(provider?, endpoint?, providerConfig?, model?, role?): LLMClient` | Build the LLM client for the judge; honours `BOBER_TEST_DETERMINISTIC=1` at line 182. |
| `resolveModel` | `src/orchestrator/model-resolver.ts:102` | `(choice: string): string` | Resolve config model shorthand to a concrete model id for `chat()`. |
| `LLMClient` / `ChatParams` / `ChatResponse` | `src/providers/types.ts:216,139,194` | interfaces | `chat({model, system, messages, jsonObjectMode}) → {text,...}`. |
| `stripCodeFences` / `extractFirstObject` | `src/chat/turn-classifier.ts:53,61` | `(text) => ...` | Defensive JSON extraction — copy these into fact-judge.ts (not exported). |

**Utilities reviewed:** `src/utils/`, `src/state/helpers.js`, `src/providers/` — no existing normalize-key or fact-reconcile helper exists; `tokenize` in retrieve.ts is private and must be re-implemented inline.

---

## 4. Prior Sprint Output

### Sprint 1: bi-temporal SQLite FactStore + `bober facts` CLI
**Created:** `src/state/facts.ts` — exports `FactStore` (insertFact / getActiveFacts / getFact / invalidateFact / close), `FactSchema`, `FactInput`, `FactRecord`, `factId`, `factsDbPath`, `ensureFactsDir`. Pure: every timestamp is injected; deterministic `factId`. Created `src/cli/commands/facts.ts` (`add/list/show/invalidate`).
**Connection to this sprint:** reconcile.ts consumes `FactStore` + `FactInput`/`FactRecord`; `writeFact` wraps `insertFact`+`invalidateFact`; the `facts add` handler (facts.ts:84-98) is rerouted through `writeFact`. The store is already pure (`now` injected) — reconcile inherits that contract.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` found. Conventions are encoded in source headers: PURE modules declare "no Date.now(), no network, no side effects" (distill.ts:1-8); CLI handlers MUST NOT throw (facts.ts:9-12).

### Architecture Decisions
`.bober/architecture/` exists but contains no ADR specific to facts/reconcile (spec is plan-driven). No reconcile ADR to follow.

### Other Docs / coding guidelines
- ESM with NodeNext: **all relative imports MUST end in `.js`** (see every import in facts.ts / reconcile sources). The new files import `../../state/facts.js`, `./fact-judge.js`, `../model-resolver.js`, `../../providers/factory.js`, `../../providers/types.js`.
- Strict TypeScript; Zod-validate-then-act; deterministic ids via sha256-slice(0,16).

---

## 6. Testing Patterns

### Unit Test Pattern — stub/fake LLMClient injection (for sc-2-6)
**Source:** `src/chat/turn-classifier.test.ts`, lines 1-20, 58-67
```typescript
import { describe, it, expect } from "vitest";
import type { LLMClient, ChatParams, ChatResponse } from "../providers/types.js";

class ScriptedClient implements LLMClient {
  readonly calls: ChatParams[] = [];
  constructor(private readonly responses: string[]) {}
  async chat(params: ChatParams): Promise<ChatResponse> {
    this.calls.push(params);
    const text = this.responses[0] ?? "";
    return { text, toolCalls: [], stopReason: "end", usage: { inputTokens: 3, outputTokens: 5 } };
  }
}
// throwing client to exercise the catch→fallback path:
const throwingClient: LLMClient = { async chat() { throw new Error("network error"); } };
```
**For sc-2-6** prefer the simpler route: define a STUB `FactJudge` directly (not even an LLMClient) — `const judge: FactJudge = { async resolve() { return "update"; } }` — and pass it to `reconcileFact(store, incoming, { judge, now })`. Assert the prior fact is superseded. Then run the SAME ambiguous input with no judge and assert a new active fact is inserted (deterministic ADD fallback). Use `ScriptedClient` only if you also want to test `createLLMFactJudge` end-to-end.

### Unit Test Pattern — in-memory FactStore + injected timestamps (for sc-2-3 / sc-2-4)
**Source:** `src/state/facts.test.ts`, lines 6-49
```typescript
describe("...", () => {
  let store: FactStore;
  afterEach(() => { store?.close(); });

  it("supersedes on changed value", async () => {
    store = new FactStore(":memory:");
    const t1 = "2026-06-15T00:00:00.000Z";
    await writeFact(store, { scope: "programming", subject: "patient",
      predicate: "medication", value: "metformin", confidence: 1,
      sourceRunId: null, tValid: t1, tCreated: t1 }, { now: t1 });
    const t2 = "2026-06-16T00:00:00.000Z";
    const action = await writeFact(store, { scope: "programming", subject: "patient",
      predicate: "medication", value: "ozempic", confidence: 1,
      sourceRunId: null, tValid: t2, tCreated: t2 }, { now: t2 });
    expect(action).toBe("update");
    const active = store.getActiveFacts("programming", "patient", "medication");
    expect(active).toHaveLength(1);
    expect(active[0].value).toBe("ozempic");
    // superseded metformin row persists with BOTH temporal fields populated:
    const oldId = factId("programming","patient","medication","metformin", t1);
    const old = store.getFact(oldId);
    expect(old?.tInvalidated).toBe(t2);   // from invalidateFact(now)
    expect(old?.tInvalid).toBe(t2);       // see §9 — must be set on supersede
  });
});
```
**Runner:** vitest. **Assertion style:** `expect`. **Mock approach:** hand-written stub objects implementing the interface (no `vi.mock`); `vi.spyOn(factory, "createClient")` for purity assertions (distill.test.ts:302-307). **File naming:** co-located `reconcile.test.ts`. **Location:** beside the source in `src/orchestrator/memory/`.

### E2E / CLI Pattern
No Playwright. evaluatorNotes asks to "exercise the CLI twice in a temp dir" — verify manually: in a scratch dir run `bober facts add --subject patient --predicate medication --value metformin` then `... --value ozempic`, then `bober facts list` shows exactly one active fact (ozempic). Not a required automated test, but the regression check.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|---|---|---|---|
| `src/state/facts.test.ts` | `FactStore`, `factId` from `facts.ts` | low | Existing in-memory tests must still pass; adding `writeFact` export is additive. |
| `src/cli/commands/facts.ts` | `FactStore`, `factsDbPath`, `ensureFactsDir`, (new) `writeFact` | medium | The `add` handler now reconciles; ensure it still prints, never throws, closes the store, and the new async `writeFact` is awaited inside the existing try/finally. |
| `src/cli/index.ts` (command registration) | `registerFactsCommand` | low | Signature of `registerFactsCommand` is unchanged — no break expected. |
| `src/orchestrator/memory/reconcile.ts` ↔ `src/state/facts.ts` | mutual via writeFact | medium | Watch for an import cycle (facts.ts → reconcile.ts → facts.ts types). Use `import type` for the FactStore/FactInput/FactRecord types in reconcile.ts to keep it type-only and avoid a runtime cycle. |

### Existing Tests That Must Still Pass
- `src/state/facts.test.ts` — tests insert/getActiveFacts/invalidate; verify unchanged after adding `writeFact`.
- `src/orchestrator/memory/distill.test.ts` / `retrieve.test.ts` — unrelated but in the same dir; confirm no accidental edits.
- `src/chat/turn-classifier.test.ts` — only relevant as the pattern source; do not modify it.

### Features That Could Be Affected
- **`bober facts add` CLI** — shares the `add` handler; verify `add` of an unchanged value prints noop (no duplicate row), a changed value supersedes, and a fresh subject/predicate adds.
- **Future Sprint 3+ (auto-producer)** — will call `writeFact`; keep the `writeFact(store, incoming, { judge?, now })` signature stable.

### Recommended Regression Checks (run after implementation)
1. `npm run build` (exit 0) and `npm run typecheck` (zero errors) — sc-2-1.
2. `npm test -- reconcile facts` — sc-2-3/sc-2-4/sc-2-6 plus the Sprint-1 store tests.
3. `npm run lint` — sc-2-7 (zero errors on new + modified files).
4. Manual CLI: in a temp dir, `facts add` metformin then ozempic for the same (scope,subject,predicate); `facts list` shows one active row (ozempic).

---

## 8. Implementation Sequence (dependency-ordered)

1. **src/orchestrator/memory/fact-judge.ts** — define `interface FactJudge { resolve(incoming, candidate): Promise<ReconcileAction> }` (import `ReconcileAction` from reconcile.ts, or co-define the type in reconcile.ts and import it here — pick one home; reconcile.ts is the natural owner of `ReconcileAction`). Implement `createLLMFactJudge()` mirroring turn-classifier.ts (tiny prompt, `jsonObjectMode:true`, Zod enum, try/catch → `"add"`).
   - Verify: file typechecks; `resolve` returns `"add"` on a non-JSON/thrown response.
2. **src/orchestrator/memory/reconcile.ts** — `ReconcileAction` type + `normalizeKey` helper + `reconcileFact` algorithm (§1). Use `import type` for FactStore/FactInput/FactRecord and FactJudge.
   - Verify: exact-match path contains NO `createClient`/`chat`/`fetch`/`Date.now()`; judge only consulted in the ambiguity branch.
3. **src/state/facts.ts** — add `writeFact(store, incoming, { judge?, now })` delegating to `reconcileFact`.
   - Verify: no import cycle (type-only import from reconcile.ts); build still green.
4. **src/cli/commands/facts.ts** — reroute the `add` handler (lines 84-98) through `await writeFact(store, input, { now })`; adapt the print for add/update/noop; keep try/catch/finally.
   - Verify: `bober facts add` runs; second changed-value add supersedes (list shows one active).
5. **src/orchestrator/memory/reconcile.test.ts** — sc-2-3 (supersede), sc-2-4 (noop, second write returns `"noop"`, no new row), sc-2-6 (stub-judge `"update"` supersedes; no-judge same input ADDs). Optionally a purity test (no `Date.now()`/`createClient` in reconcile.ts source) mirroring distill.test.ts:292-307.
   - Verify: `npm test -- reconcile facts` green with NO judge injected for sc-2-3/sc-2-4.
6. **Run full verification** — `npm run build`, `npm run typecheck`, `npm test -- reconcile facts`, `npm run lint`.

---

## 9. Pitfalls & Warnings

- **`t_invalid` vs `t_invalidated` on supersede (sc-2-3 is explicit).** `invalidateFact(id, now)` only sets `t_invalidated` (facts.ts:260-269). sc-2-3 AND evaluatorNotes require the superseded row to carry **both** `t_invalid` AND `t_invalidated`. The store has NO method to set `t_invalid`. generatorNotes step (3) says: on UPDATE, "set the old row's `t_invalid` to the incoming `tValid`." You must add a small store method (e.g. `setInvalidEnd(id, tInvalid)` running `UPDATE semantic_facts SET t_invalid=? WHERE id=?`) OR have reconcileFact issue that update. **Do not skip this** — the test asserts `tInvalid` is populated. Keep it pure (inject the timestamp = incoming `tValid`).
- **Only ACTIVE facts gate reconcile.** Step (1) uses `getActiveFacts` (t_invalidated IS NULL). An incoming value equal to an already-INACTIVE prior fact must still ADD (it won't match any active row). Do not query `getFact`/all rows for the NOOP check.
- **Confidence carries from the incoming on supersede.** Insert `incoming` verbatim (incl. its `confidence`) — do not copy the old fact's confidence (evaluatorNotes).
- **DELETE inserts nothing.** On judge `"delete"`, only `invalidateFact(candidate.id, now)`; never `insertFact`.
- **No LLM on the exact-match path.** sc-2-3/sc-2-4 run with no judge — the exact-match branches must contain zero `createClient`/`chat` calls. The judge import must NOT pull `createClient` into reconcile.ts at runtime (import the `FactJudge` type with `import type`).
- **No judge → ADD, never NOOP.** When a normalized collision is found but no judge is provided, the deterministic fallback is ADD (insert a new active fact), not noop.
- **`tokenize` is private.** Do not `import { tokenize }` from retrieve.ts — it is not exported. Re-implement `normalizeKey` inline.
- **ESM `.js` specifiers.** Every relative import needs `.js` (NodeNext). Missing extensions fail `npm run build`.
- **CLI handler must not throw.** Keep `process.exitCode = 1` + `return` on error and `finally { store.close() }`; do not let `writeFact`'s promise reject escape the try.
- **Import cycle risk.** facts.ts → reconcile.ts → facts.ts (types). Use `import type` in reconcile.ts for everything from facts.ts so the cycle is erased at compile time. If a cycle still bites build, move `writeFact` into reconcile.ts and import it from there in the CLI.
