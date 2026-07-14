import { createHash } from "node:crypto";
import type { Finding } from "./finding.js";
import type { FactStore } from "../state/facts.js";
import { writeFinding } from "./finding-store.js";

// ── Constants ─────────────────────────────────────────────────────────

/** Fallback domain when none is provided — required min(1) on FindingSchema. */
const DEFAULT_DOMAIN = "inbox";

// ── captureTask ───────────────────────────────────────────────────────

/**
 * Build a Finding from free text and persist it to the hub pool.
 *
 * Deterministic enrichment only: id is derived from title+now (no clock
 * call here — `now` is always injected at the CLI boundary). All unknown
 * fields are omitted; urgency/severity are set to safe neutral defaults.
 *
 * PURE: never calls Date.now() / new Date().
 */
export async function captureTask(
  store: FactStore,
  text: string,
  { domain, now }: { domain?: string; now: string },
): Promise<Finding> {
  const title = text.trim();
  // Stable deterministic id — no clock dependency
  const id = createHash("sha256")
    .update(`${title}|${now}`)
    .digest("hex")
    .slice(0, 16);

  const finding: Finding = {
    id,
    domain: domain ?? DEFAULT_DOMAIN, // REQUIRED min(1) — cannot be empty
    title,
    kind: "action",
    urgency: 3, // neutral default (contract assumption §3a)
    severity: 1, // neutral default
    evidence: [],
    surfacedAt: now,
    tags: domain ? [`domain:${domain}`] : [],
    status: "open",
    // dueBy / estDurationMin / calendarSafeTitle / promotesTo: OMITTED (optional)
  };

  await writeFinding(store, finding, { now });
  return finding;
}
