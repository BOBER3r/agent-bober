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

// ── Snooze helpers ────────────────────────────────────────────────────

/** Tag prefix used to encode the wake time on a snoozed Finding. */
export const SNOOZE_TAG_PREFIX = "snooze-until:";

/**
 * Extract the wake-time ISO string from a Finding's tags, or null if absent
 * or if no valid snooze-until tag exists.
 * PURE: no clock read; tag parsing only.
 */
export function snoozeUntil(finding: Finding): string | null {
  const tag = finding.tags.find((t) => t.startsWith(SNOOZE_TAG_PREFIX));
  return tag !== undefined ? tag.slice(SNOOZE_TAG_PREFIX.length) : null;
}

/**
 * Returns true when a Finding should appear in the default task list.
 *
 * Visibility rules:
 *  - open / in-progress → always visible
 *  - snoozed + valid wake time in the future (wake > now) → hidden
 *  - snoozed + wake time <= now (past or present) → visible again
 *  - snoozed + no snooze-until tag → visible (user must re-triage)
 *  - done / dropped → not visible
 *
 * PURE: `now` is injected; no Date.now() or new Date() inside.
 * Lexicographic ISO compare is safe because both sides are toISOString()
 * output (YYYY-MM-DDTHH:mm:ss.sssZ — fixed-width, lexicographically ordered).
 */
export function isVisibleInDefaultList(finding: Finding, now: string): boolean {
  if (finding.status === "open" || finding.status === "in-progress") {
    return true;
  }
  if (finding.status === "snoozed") {
    const wake = snoozeUntil(finding);
    // No tag → treat as visible so the user can re-triage
    if (wake === null) return true;
    return wake <= now;
  }
  return false;
}
