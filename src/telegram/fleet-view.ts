/** fleet-view.ts — Read-only secretary view of the most recent fleet run. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { findProjectRoot } from "../utils/fs.js";
import { isAllowed, denialReply } from "./whitelist.js";
import type { AllowedUsers } from "./whitelist.js";
import type { SynthesisBundle } from "../fleet/synthesis.js"; // TYPE-ONLY — erased at compile
import type { FactRecord } from "../state/facts.js"; // TYPE-ONLY — no better-sqlite3 leaks

// ── Constants ─────────────────────────────────────────────────────────

/** Maximum characters shown on the one-line summary before truncation. */
const MAX_LINE_LENGTH = 120;

// ── Truncation helper ─────────────────────────────────────────────────

/**
 * Collapse a multi-line value to its first line and cap at MAX_LINE_LENGTH.
 * Never emits line 2+ or content beyond the cap. Private to this module.
 */
function oneLine(value: string): string {
  const first = value.split("\n")[0]!;
  return first.length > MAX_LINE_LENGTH ? first.slice(0, MAX_LINE_LENGTH) + "…" : first;
}

// ── Injected reader ───────────────────────────────────────────────────

/** Returns the parsed bundle, or null when absent/unparseable. Tests inject a fake. */
export type SynthesisReader = () => Promise<SynthesisBundle | null>;

// ── defaultSynthesisReader ────────────────────────────────────────────

/**
 * Production reader: reads <projectRoot>/.bober/fleet-synthesis.json
 * via node:fs/promises and JSON.parse. Returns null on ENOENT or parse failure
 * (e.g. non-blackboard run — the file is absent by design in that case).
 *
 * bober: single-process JSON read; swap for a streaming parser if
 *        fleet-synthesis.json ever exceeds a few MB in practice.
 */
export async function defaultSynthesisReader(): Promise<SynthesisBundle | null> {
  const root = (await findProjectRoot()) ?? process.cwd();
  const path = join(root, ".bober", "fleet-synthesis.json");
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as SynthesisBundle; // shape is the on-disk contract
  } catch {
    // ENOENT or JSON.parse failure → graceful empty state (never throw)
    return null;
  }
}

// ── renderFleetView (PURE) ────────────────────────────────────────────

/**
 * Group bundle.findings by FactRecord.subject and emit one section per agent.
 * Returns string[]: index 0 is the header (shows bundle.rounds), subsequent
 * elements are agent sections (label + one-line summary + round + confidence + count).
 *
 * PURE: no IO, no throw, deterministic output from the same input.
 *
 * CRITICAL: FactRecord has NO round field (round is lost at publish() in
 * shared-blackboard.ts). The per-section round AND the header round both
 * come from bundle.rounds (the run-level count). Do NOT reference finding.round.
 */
export function renderFleetView(bundle: SynthesisBundle): string[] {
  const { rounds, findings } = bundle;
  const header = `Fleet Run — Rounds: ${rounds} | Total findings: ${findings.length}`;

  if (findings.length === 0) {
    return [header];
  }

  // Group findings by subject (per-agent childFolder set by shared-blackboard.ts:publish)
  const grouped = new Map<string, FactRecord[]>();
  for (const f of findings) {
    const arr = grouped.get(f.subject) ?? [];
    arr.push(f);
    grouped.set(f.subject, arr);
  }

  const sections: string[] = [header];

  for (const [subject, group] of grouped) {
    // Latest finding = max tCreated (ISO-8601 strings sort lexicographically)
    const latest = group.reduce((a, b) => (a.tCreated >= b.tCreated ? a : b));
    const summary = oneLine(latest.value);
    const confidence = latest.confidence.toFixed(2);
    const count = group.length;

    sections.push(
      `${subject}\nSummary: ${summary}\nRound: ${rounds} | Confidence: ${confidence} | Findings: ${count}`,
    );
  }

  return sections;
}

// ── handleFleet ───────────────────────────────────────────────────────

/**
 * /fleet command handler.
 *
 * Sequence:
 *   1. Gate FIRST — non-whitelisted senders get denialReply; reader is never called (sc-7-6).
 *   2. Read bundle via injected reader (default: disk via defaultSynthesisReader).
 *   3. Absent or empty findings → return a friendly "no recent fleet run" message.
 *   4. Non-empty bundle → return renderFleetView sections joined into one reply string.
 *
 * Returns a plain string for the caller to pass through sendSafe — no transport access here.
 */
export async function handleFleet(
  senderId: number,
  allowed: AllowedUsers,
  reader: SynthesisReader = defaultSynthesisReader,
): Promise<string> {
  // Gate FIRST: reader must never be called for non-whitelisted senders (sc-7-6).
  if (!isAllowed(senderId, allowed)) {
    return denialReply(senderId);
  }

  const bundle = await reader();

  if (bundle === null || bundle.findings.length === 0) {
    return "No recent fleet run. Run a fleet command with --blackboard to see per-agent findings here.";
  }

  return renderFleetView(bundle).join("\n\n");
}
