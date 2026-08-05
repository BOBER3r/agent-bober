import { BudgetExceededError } from "../../orchestrator/workflow/budget.js";
import { LedgerEntrySchema } from "../state/overall.js";
import type { BudgetLedgerState, LedgerEntry } from "../state/overall.js";
import type {
  BudgetLedger as NodeContextBudgetLedger,
  NodeUsage,
} from "../registry/nodes.js";
import type { Implements } from "./scratch.js";

/**
 * Replay-idempotent cost accounting, keyed by `(nodeId, attempt, callIndex)`.
 *
 * ── Why `charge` REPLACES ──
 *
 * The obvious ledger is an accumulator: `total += usage`. It is wrong here, and wrong in
 * a way that is invisible until money is involved. A superstep can be re-executed — a
 * crash-resume replays the frontier from the last checkpoint, a retried branch runs the
 * same node again at the same `attempt`, a resumed HITL interrupt re-enters the node it
 * suspended in — and an accumulator bills every one of those replays as new spend. The
 * run's reported cost then drifts above what the provider actually charged, budgets trip
 * early, and the per-node breakdown stops summing to the total.
 *
 * So a charge is a keyed UPSERT: the same `(nodeId, attempt, callIndex)` charged twice
 * leaves exactly one entry. This is the same rule the `ledger` CHANNEL uses (`mergeLedger`
 * replaces by key), which is what makes the in-memory ledger and the committed state
 * agree after a resume. Do not "simplify" this into `+=`.
 *
 * ── Not a store ──
 *
 * This module writes NO files and therefore takes no `projectRoot`. The ledger's durable
 * form is the `ledger` channel of {@link OverallState}, persisted by the commit boundary
 * like every other channel. `ledger.test.ts` asserts that constructing and charging a
 * ledger leaves the filesystem untouched, so "it is not a store" is verified rather than
 * asserted in prose.
 *
 * ── One `BudgetExceededError` ──
 *
 * The error class is IMPORTED from `src/orchestrator/workflow/budget.ts` rather than
 * redefined. Two classes with one name, thrown from two layers of the same product, is
 * exactly the ambiguity a `catch (e) { if (e instanceof BudgetExceededError) }` cannot
 * see. That module is dependency-free, so importing it drags nothing in.
 */

export { BudgetExceededError } from "../../orchestrator/workflow/budget.js";

// ── Key ─────────────────────────────────────────────────────────────

export interface LedgerChargeKey {
  nodeId: string;
  attempt: number;
  callIndex: number;
}

/**
 * The identity of one charge.
 *
 * NUL-separated because it is not parsed back: a node id containing the separator would
 * otherwise be able to collide with a different node's key.
 */
export function ledgerKey(key: LedgerChargeKey): string {
  return `${key.nodeId}\u0000${key.attempt}\u0000${key.callIndex}`;
}

export const ZERO_USAGE: Readonly<NodeUsage> = Object.freeze({
  calls: 0,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
});

function addUsage(into: NodeUsage, entry: LedgerEntry): NodeUsage {
  return {
    calls: into.calls + entry.calls,
    tokensIn: into.tokensIn + entry.tokensIn,
    tokensOut: into.tokensOut + entry.tokensOut,
    costUsd: into.costUsd + entry.costUsd,
  };
}

// ── Ledger ──────────────────────────────────────────────────────────

/**
 * The ledger.
 *
 * Wider than the {@link NodeContextBudgetLedger} a node body is handed: a node may
 * `charge` and read totals, but `assertWithinCeiling`, `merge` and `entries` belong to
 * the interpreter and the commit boundary.
 */
export interface BudgetLedger {
  charge(key: LedgerChargeKey, usage: NodeUsage): void;
  totals(): NodeUsage;
  perNode(): Record<string, NodeUsage>;
  /** The serialisable channel value, sorted for a stable artifact. */
  entries(): BudgetLedgerState;
  /** Fold committed entries back in on resume. Replace-by-key, exactly like `charge`. */
  merge(entries: readonly LedgerEntry[]): void;
  /** Throw {@link BudgetExceededError} when total spend has passed `ceilingUsd`. */
  assertWithinCeiling(ceilingUsd: number): void;
}

/** sc-6-11 — the concrete ledger is still a legal `NodeContext.ledger`. */
export const _budgetLedgerImplementsNodeContext: Implements<
  BudgetLedger,
  NodeContextBudgetLedger
> = true;

/**
 * A fresh ledger, optionally seeded with entries recovered from a checkpoint.
 *
 * Per-run, never module-level: a process that runs two pipelines must not bill one
 * against the other.
 */
export function createBudgetLedger(seed: readonly LedgerEntry[] = []): BudgetLedger {
  const byKey = new Map<string, LedgerEntry>();

  function upsert(entry: LedgerEntry): void {
    // Zod at the boundary: a NaN cost or a negative token count would otherwise poison
    // every later total silently.
    const parsed = LedgerEntrySchema.parse(entry);
    byKey.set(ledgerKey(parsed), parsed);
  }

  for (const entry of seed) upsert(entry);

  return {
    charge(key, usage): void {
      upsert({
        nodeId: key.nodeId,
        attempt: key.attempt,
        callIndex: key.callIndex,
        calls: usage.calls,
        tokensIn: usage.tokensIn,
        tokensOut: usage.tokensOut,
        costUsd: usage.costUsd,
      });
    },

    merge(entries): void {
      for (const entry of entries) upsert(entry);
    },

    totals(): NodeUsage {
      let total: NodeUsage = { ...ZERO_USAGE };
      for (const entry of byKey.values()) total = addUsage(total, entry);
      return total;
    },

    perNode(): Record<string, NodeUsage> {
      // A null-prototype record, so a node id of "constructor" or "__proto__" is a key
      // like any other rather than a collision with Object.prototype.
      const perNode: Record<string, NodeUsage> = Object.create(null) as Record<string, NodeUsage>;
      for (const entry of byKey.values()) {
        perNode[entry.nodeId] = addUsage(perNode[entry.nodeId] ?? { ...ZERO_USAGE }, entry);
      }
      return perNode;
    },

    entries(): BudgetLedgerState {
      // Copies, not the stored objects: the channel value is handed to a reducer and
      // must not be a live view of the ledger's internals.
      return [...byKey.values()]
        .map((entry) => ({ ...entry }))
        .sort(
          (a, b) =>
            a.nodeId.localeCompare(b.nodeId) ||
            a.attempt - b.attempt ||
            a.callIndex - b.callIndex,
        );
    },

    assertWithinCeiling(ceilingUsd): void {
      let spent = 0;
      for (const entry of byKey.values()) spent += entry.costUsd;
      if (spent > ceilingUsd) {
        throw new BudgetExceededError(
          `Budget ceiling exceeded: spent $${spent.toFixed(6)} of $${ceilingUsd.toFixed(6)}.`,
          "usd",
        );
      }
    },
  };
}
