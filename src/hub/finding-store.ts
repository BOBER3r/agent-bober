import { FindingSchema } from "./finding.js";
import type { Finding } from "./finding.js";
import { HUB_SCOPE } from "./finding-source.js";
import type { FactStore } from "../state/facts.js";
import { writeFact } from "../state/facts.js";
import type { ReconcileAction } from "../state/facts.js";

// ── writeFinding ──────────────────────────────────────────────────────

/**
 * Persist a Finding into the hub pool via the reconcile layer.
 * Routes through writeFact (not raw insertFact) so dedup/supersede works.
 *
 * PURE: never reads the clock; `now` is injected by the CLI boundary.
 */
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

// ── readFindings ──────────────────────────────────────────────────────

/**
 * Read all active hub Findings from the store.
 * Uses FindingSchema.parse — throws on malformed rows (unlike the
 * safeParse+skip approach in FactStoreFindingSource).
 */
export function readFindings(store: FactStore): Finding[] {
  return store
    .getActiveFacts(HUB_SCOPE, undefined, "finding")
    .map((r) => FindingSchema.parse(JSON.parse(r.value) as unknown));
}

// ── transitionFinding ─────────────────────────────────────────────────

/**
 * Read the active Finding for `id`, apply `newStatus` (+ optional field
 * mutation), and write it back via writeFinding. Because subject=id and
 * predicate='finding' are unchanged but the value differs, reconcileFact
 * takes the UPDATE branch (supersede old + insert new), preserving the
 * prior row as bitemporal history (reconcile.ts:70-78).
 *
 * Returns the new Finding, or null if no active Finding has that id.
 * PURE: never reads the clock — `now` is injected at the CLI boundary.
 */
export async function transitionFinding(
  store: FactStore,
  id: string,
  newStatus: Finding["status"],
  { now, mutate }: { now: string; mutate?: Partial<Finding> },
): Promise<Finding | null> {
  const current = readFindings(store).find((f) => f.id === id);
  if (current === undefined) return null;
  const next: Finding = { ...current, ...mutate, status: newStatus };
  await writeFinding(store, next, { now });
  return next;
}
