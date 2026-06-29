# Do-Bridge: Promote a Finding into Real Work

`bober do <id>` promotes a hub Finding into a `bober run` task. It reads the
Finding from the FactStore, picks the right Promoter from the PromoterRegistry,
asks for human approval (TTY) or proceeds automatically (--yes), and launches
a child `bober run` process. After launch, the Finding transitions to
`in-progress` and carries a `PromotionRef` recording the run id. The
`--reconcile` flag (or the automatic best-effort reconcile at the start of
every `bober do`) closes the loop: it reads each launched run's
`.bober/runs/<runId>/state.json` snapshot and advances the Finding to its
terminal status.

See `src/do-bridge/` for the implementation and `src/cli/commands/do.ts` for
the CLI boundary that wires everything together.

---

## The Promoter Registry Extension Point

Every domain-specific promotion strategy is a **Promoter** — a pure function
that converts a hub Finding into a `PromotionPlan`. Promoters are registered in
a **PromoterRegistry** at the CLI boundary and looked up at runtime by the
finding's `(domain, kind)` pair.

### Call Site

The exact registration call site is **`src/cli/commands/do.ts`** inside
`registerDoCommand`, at the block that constructs the `PromoterRegistry`:

```typescript
const registry = new PromoterRegistry();
registry.register({ domain: "coding" }, codingPromoter);
registry.register({ domain: "projects" }, codingPromoter);
// STUB — not functional; exists only to prove the registry accepts a new key.
const projectsActionStub: Promoter = (_f) => ({
  kind: "bober-run",
  task: "STUB — not functional",
});
registry.register({ domain: "projects", kind: "action" }, projectsActionStub);
```

This is the single place to add new domain promoters. The registry is
constructed fresh for every `bober do` invocation — there is no singleton.

### The Promoter Interface

```typescript
// src/do-bridge/types.ts
export type Promoter = (finding: Finding) => PromotionPlan;
```

A Promoter is a **pure function**: it takes a `Finding` and returns a
`PromotionPlan`. It performs no I/O, reads no clock, and has no side effects.
All context it needs must come from the finding itself (title, tags, evidence).

```typescript
export interface PromotionPlan {
  kind: "bober-run";
  /** The one-line task string passed to bober run. */
  task: string;
  /** Optional team id; undefined means the default team. */
  teamId?: string;
}
```

### The PromoterKey Shape

```typescript
// src/do-bridge/types.ts
export interface PromoterKey {
  domain: string;
  kind?: FindingKind;  // "action" | "watch" | "risk" | "question"
}
```

`kind` is optional. A domain-only key (`{ domain: "coding" }`) registers a
fallback promoter for all kinds within that domain. A domain+kind key
(`{ domain: "projects", kind: "action" }`) overrides the fallback for that
specific kind.

### Resolution Precedence

```
registry.resolve({ domain, kind })
  1. domain+kind specific match   → used if registered
  2. domain-only fallback         → used if no specific match exists
  3. undefined                    → bober do exits non-zero naming the domain
```

An unregistered `(domain, kind)` **fails closed** — `bober do` sets
`process.exitCode = 1` and prints an error naming the domain. There is no
default catch-all promoter.

### Adding a Medical or Financial Promoter

To extend the registry for a new domain, add a `register` call in
`src/cli/commands/do.ts` at the call site shown above:

```typescript
// 1. Implement the promoter in src/do-bridge/medical-promoter.ts
import { medicalPromoter } from "../../do-bridge/medical-promoter.js";

// 2. Register it (add this line at the call site):
registry.register({ domain: "medical" }, medicalPromoter);

// Or register for a specific kind only:
registry.register({ domain: "financial", kind: "action" }, financialActionPromoter);
```

The promoter function receives the full `Finding` object — it can read
`finding.domain`, `finding.title`, `finding.urgency`, `finding.evidence`,
and `finding.tags` (including `team:<id>` tags) to build the `PromotionPlan`.

---

## Reconciling Launched Promotions

After `bober do <id>` launches a run, the Finding sits at `status: "in-progress"`
with a `promotesTo` field carrying a JSON-serialized `PromotionRef`:

```typescript
export interface PromotionRef {
  kind: "bober-run";
  runId: string;
  launchedAt: string;
  status: "launched" | "completed" | "aborted";
}
```

`bober do --reconcile` (or the automatic best-effort reconcile at the start
of every `bober do`) reads each launched run's state file and advances the
Finding:

| Run `state.json` status | Finding transition | `promotesTo.status` |
|---|---|---|
| `completed` | `in-progress` → `done` | `completed` |
| `aborted` or `failed` | `in-progress` → `open` | `aborted` |
| `running` (or missing) | unchanged | unchanged |

The reconcile is **snapshot-based** — it reads the current
`.bober/runs/<runId>/state.json` and returns immediately. It does NOT poll
or block waiting for an in-flight run to finish.

### Best-Effort Guarantee

Reconcile is always wrapped in try/catch at the CLI boundary:

```typescript
// src/cli/commands/do.ts — mirrors seedProjectFacts in pipeline.ts:981
try {
  await reconcilePromotionsForRoot(projectRoot, findingStore, () => new Date().toISOString());
} catch (err) {
  logger.warn(`Reconcile skipped: ${err instanceof Error ? err.message : String(err)}`);
}
```

A missing or corrupt `state.json` returns `null` from `readRunState` and is
treated as "still running" — the Finding is left unchanged. A reconcile failure
can **never** abort `bober do`.

### Reconcile Implementation

The core is in `src/do-bridge/reconcile.ts`:

```typescript
// DI core — inject a fake readState for unit tests (no real run needed)
export async function reconcilePromotions(deps: ReconcileDeps): Promise<ReconcileSummary>

// CLI wrapper — injects the real readRunState adapter
export async function reconcilePromotionsForRoot(
  projectRoot: string,
  store: FindingStore,
  now: () => string,
): Promise<ReconcileSummary>
```

The `FactStore`-backed transition goes through `transitionFinding`
(`src/hub/finding-store.ts:63`) which uses `supersedeFact` for bitemporal
history — the old row is closed with a `tInvalidated` timestamp, and the new
status is inserted as a fresh active row.

---

## The FindingStore Port

`src/do-bridge/finding-port.ts` defines the narrow port interface that
`bober do` and `reconcilePromotions` use to read/write Findings. It hides the
raw JSON string that `FindingSchema.promotesTo` stores on disk and exposes a
structured `PromotionRef` object instead.

The port has two adapters:

- `FactStoreFindingStore` — backed by the real SQLite FactStore; used in
  production by `registerDoCommand`.
- `InMemoryFindingStore` — backed by a `Map<string, DoFinding>`; used in unit
  tests to avoid filesystem and SQLite.

---

## Related

- `docs/chat-steer.md` — approval markers written by `bober do` and read by
  the child run process at curated pipeline gates.
- `docs/teams.md` — team ids referenced via `team:<id>` tags on Findings, and
  how `bober run --team` routes the launched task to the right provider.
- `src/do-bridge/coding-promoter.ts` — reference implementation of a Promoter.
- `src/do-bridge/registry.ts` — PromoterRegistry with resolution precedence.
- `src/state/run-state.ts` — `readRunState` null-safe reader used by reconcile.
