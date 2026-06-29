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
