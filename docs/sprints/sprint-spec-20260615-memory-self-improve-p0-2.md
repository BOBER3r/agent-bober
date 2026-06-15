# Reconcile-on-write — deterministic supersede + LLM-judged ambiguity

**Contract:** sprint-spec-20260615-memory-self-improve-p0-2  ·  **Spec:** spec-20260615-memory-self-improve-p0  ·  **Completed:** 2026-06-15

## What this sprint added

Fact writes now flow through a **reconcile-on-write** step instead of a raw insert.
The deterministic core (`reconcileFact`) handles the clean cases with **no LLM at all**: an
exact `(scope, subject, predicate)` active match with the **same** value is a `noop`, the
same key with a **different** value **supersedes** the old fact (soft-invalidate + insert),
and a fresh subject+predicate is an `add`. Only a genuinely **ambiguous** case — an incoming
fact whose *normalized* subject+predicate collides with an active fact but has no exact match —
consults an **injected LLM `FactJudge`**, and even then a missing judge (or any judge
failure) falls back deterministically to `add`. The result: `bober facts add` of a changed
value now supersedes rather than duplicating, while the exact-match and idempotent paths stay
LLM-free and reproducible.

The core stays as pure as the Sprint 1 store: `reconcileFact` never reads the clock (`now` is
injected) and never calls `createClient` or the network — the judge is the sole async/LLM
surface, isolated in its own module with a defensive `add` fallback so the LLM can never
corrupt the store.

## Public surface

- `reconcileFact(store, incoming, { judge?, now }): Promise<ReconcileAction>` (`src/orchestrator/memory/reconcile.ts:51`) — pure reconcile core. Returns the action it took: `'add'` | `'update'` | `'delete'` | `'noop'`. Reads only active facts; mutates only via the injected `store`.
- `writeFact(store, incoming, { judge?, now }): Promise<ReconcileAction>` (`src/orchestrator/memory/reconcile.ts:148`) — thin reconcile-then-write wrapper. Lives in `reconcile.ts` (not `facts.ts`) to avoid a runtime `state → orchestrator` import cycle, and is **re-exported from `src/state/facts.ts`** so consumers can import it from the facts module.
- `type ReconcileAction` (`src/orchestrator/memory/reconcile.ts:16`) — `'add' | 'update' | 'delete' | 'noop'`; also re-exported from `src/state/facts.ts`.
- `interface FactJudge { resolve(incoming, candidate): Promise<ReconcileAction> }` (`src/orchestrator/memory/fact-judge.ts:25`) — injectable resolver for normalized-key ambiguity; consulted only on a collision with no exact match.
- `createLLMFactJudge(provider?, endpoint?, providerConfig?, model?): FactJudge` (`src/orchestrator/memory/fact-judge.ts:143`) — builds an LLM-backed judge via `createClient` (`src/providers/factory.ts`) — the **only** `createClient` import site in the reconcile layer. Honours `BOBER_TEST_DETERMINISTIC=1` (the stub client yields non-JSON → the `add` fallback). Defaults to the `sonnet` model via `resolveModel`.
- `FactStore.supersedeFact(id, tInvalidated, tInvalid): boolean` (`src/state/facts.ts:281`) — closes **both** bi-temporal fields in one update: `t_invalidated` (record-time = `now`) **and** `t_invalid` (world-time end = the incoming fact's `tValid`), only on a currently-active row. Returns `false` if the id is unknown or already invalidated. (Distinct from Sprint 1's `invalidateFact`, which sets `t_invalidated` only.)
- CLI `bober facts add` (`src/cli/commands/facts.ts`) — now routes through `writeFact` (no judge wired → deterministic only) and prints action-aware output: green **`Added fact`**, yellow **`Superseded — prior fact invalidated.`**, or gray **`Fact unchanged (identical value already active).`**

## How to use / how it fits

The exact-match path is the common case and is fully deterministic — no judge needed:

```ts
import { FactStore, factsDbPath, writeFact } from "./state/facts.js";

const store = new FactStore(factsDbPath(projectRoot, ns));
try {
  const now = new Date().toISOString();              // clock read OUTSIDE the core
  await writeFact(store, mkFact("patient", "medication", "metformin", now), { now });
  // later, a changed value for the same (scope,subject,predicate):
  const t2 = new Date().toISOString();
  await writeFact(store, mkFact("patient", "medication", "ozempic", t2), { now: t2 });
  // → 'update': exactly one active fact (ozempic); the metformin row persists with
  //   BOTH t_invalidated=t2 AND t_invalid=t2 set, so history stays inspectable.
} finally {
  store.close();
}
```

From the CLI (no judge — deterministic ADD/UPDATE/NOOP only):

```bash
bober facts add --scope patient --subject patient --predicate medication --value metformin   # Added fact
bober facts add --scope patient --subject patient --predicate medication --value ozempic      # Superseded — prior fact invalidated.
bober facts add --scope patient --subject patient --predicate medication --value ozempic      # Fact unchanged (identical value already active).
```

To enable judged ambiguity resolution, pass a judge explicitly:

```ts
import { createLLMFactJudge } from "./orchestrator/memory/fact-judge.js";
const judge = createLLMFactJudge();
await writeFact(store, incoming, { judge, now });    // judge consulted ONLY on a normalized-key collision
```

This is the second sprint of `spec-20260615-memory-self-improve-p0`: Sprint 1 landed the
store and a manual CLI; this sprint adds the **write discipline** (dedupe + supersede) on top.
Facts are still **not wired into planning or the pipeline** — producers and a retrieval path
are later sprints.

## Notes for maintainers

- **The LLM is never on the exact-match path.** `noop` / `update` (supersede) / fresh `add`
  all run with no judge and no network — that is what makes `bober facts add` reproducible and
  is the property the supersede/NOOP unit tests assert with no judge injected. Do not move
  any LLM call earlier in the algorithm.
- **Ambiguity is detected deterministically.** `normalizeKey` lowercases and strips
  non-alphanumerics from `subject|predicate` (mirroring `tokenize()` in `retrieve.ts`); it is
  private to `reconcile.ts` on purpose (`tokenize` is not exported there — do not cross-import).
  The judge is consulted **only** when this normalized key collides with an active fact *and*
  no exact match exists.
- **No-judge / failing-judge → `add`.** A collision with no judge falls back to `add`; the
  `LLMFactJudge` returns `'add'` on any thrown error, any parse failure, or an unrecognized
  action enum. The judge can drop or merge a fact but can never silently destroy the store's
  consistency — the worst case is a duplicate active fact, recoverable by hand.
- **`supersedeFact` vs `invalidateFact`.** Reconcile's UPDATE/DELETE use `supersedeFact`
  (sets both `t_invalidated` and `t_invalid`); the Sprint 1 CLI `invalidate` command still uses
  `invalidateFact` (record-time only). This means **superseded rows now carry a non-NULL
  `t_invalid`** — updating the Sprint 1 note that `t_invalid` was "always NULL" (still true for
  rows closed via `invalidate`, no longer true for rows closed via supersede).
- **Confidence carries from the incoming value** on supersede (the new row is inserted with the
  incoming fact's confidence; the old row is only closed, not rewritten).
- **Reconciliation gates on *active* facts only.** An incoming value equal to an already-
  invalidated prior fact still `add`s — `getActiveFacts` is the only thing reconcile reads.
- **DELETE inserts nothing.** A judge `'delete'` supersedes the candidate and does **not**
  insert the incoming fact; `'noop'` leaves the store untouched.
- **Import-cycle guard.** `reconcile.ts` imports `FactStore`/`FactInput`/`FactRecord` with
  `import type` only; the runtime re-export of `writeFact` lives in `facts.ts`. Keep `writeFact`
  in `reconcile.ts` to avoid reintroducing a runtime `state → orchestrator` cycle.
