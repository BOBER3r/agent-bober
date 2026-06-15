/**
 * PURE deterministic reconcile-on-write for semantic facts.
 *
 * PURE — never reads the clock (now is injected), never calls createClient,
 * no network access, no Date.now(), no side effects beyond the injected store.
 * The injected FactJudge is the ONLY async/LLM surface and is consulted ONLY
 * on a deterministic normalized-key collision (the ambiguity branch).
 * Exact-match NOOP/UPDATE/ADD never touch the judge or the network.
 */

import type { FactStore, FactInput } from "../../state/facts.js";
import type { FactJudge } from "./fact-judge.js";

// ── Types ────────────────────────────────────────────────────────────────

export type ReconcileAction = "add" | "update" | "delete" | "noop";

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Normalize a subject+predicate pair into a collision key.
 * Lowercase + strip non-alphanumeric characters — mirrors tokenize() in retrieve.ts:30-35.
 * Private to this module; do not import from retrieve.ts (it is not exported).
 */
function normalizeKey(subject: string, predicate: string): string {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return `${norm(subject)}|${norm(predicate)}`;
}

// ── Core ──────────────────────────────────────────────────────────────────

/**
 * Reconcile an incoming fact against the active state in the store.
 *
 * Algorithm:
 * 1. Query getActiveFacts(scope, subject, predicate) — exact key, active-only.
 * 2. Exact match with SAME value → NOOP.
 * 3. Exact match with DIFFERENT value → UPDATE:
 *    supersedeFact(old.id, now, incoming.tValid) then insertFact(incoming).
 * 4. No exact match → AMBIGUITY check via normalizeKey over all active facts in scope.
 *    a. Collision AND judge provided → judge.resolve(incoming, candidate) → apply.
 *    b. Collision but NO judge → deterministic ADD fallback.
 *    c. No collision → ADD.
 * 5. DELETE = supersedeFact(candidate.id, now, incoming.tValid) without inserting incoming.
 *
 * @param store - The FactStore to read from and write to.
 * @param incoming - The incoming fact input (validated by insertFact on the ADD path).
 * @param opts.judge - Optional LLM-backed judge for ambiguity resolution.
 * @param opts.now - ISO 8601 wall-clock timestamp (record-time); NEVER read inside.
 */
export async function reconcileFact(
  store: FactStore,
  incoming: FactInput,
  { judge, now }: { judge?: FactJudge; now: string },
): Promise<ReconcileAction> {
  // ── Step 1: Exact-key lookup (active only) ────────────────────────────
  const exactMatches = store.getActiveFacts(
    incoming.scope,
    incoming.subject,
    incoming.predicate,
  );

  // ── Step 2: Same value → NOOP ─────────────────────────────────────────
  if (exactMatches.length > 0) {
    const same = exactMatches.find((r) => r.value === incoming.value);
    if (same !== undefined) {
      return "noop";
    }

    // ── Step 3: Different value → UPDATE (supersede) ─────────────────────
    // Supersede every matching active row (normally only one, but be safe).
    for (const old of exactMatches) {
      // Set BOTH t_invalid (world-time = incoming tValid) AND t_invalidated (record-time = now)
      store.supersedeFact(old.id, now, incoming.tValid);
    }
    store.insertFact(incoming);
    return "update";
  }

  // ── Step 4: No exact match → Ambiguity check ─────────────────────────
  const incomingKey = normalizeKey(incoming.subject, incoming.predicate);
  const allActive = store.getActiveFacts(incoming.scope);
  const candidate = allActive.find(
    (r) => normalizeKey(r.subject, r.predicate) === incomingKey,
  );

  if (candidate !== undefined) {
    // ── Step 4a: Collision AND judge → delegate ───────────────────────
    if (judge !== undefined) {
      const action = await judge.resolve(incoming, candidate);
      return applyJudgeDecision(store, incoming, candidate, action, now);
    }
    // ── Step 4b: Collision but NO judge → deterministic ADD fallback ──
    store.insertFact(incoming);
    return "add";
  }

  // ── Step 4c: No collision → ADD ───────────────────────────────────────
  store.insertFact(incoming);
  return "add";
}

/**
 * Apply a judge's decision to the store.
 * DELETE = supersede candidate only; no insertFact.
 */
function applyJudgeDecision(
  store: FactStore,
  incoming: FactInput,
  candidate: { id: string; tValid: string },
  action: ReconcileAction,
  now: string,
): ReconcileAction {
  switch (action) {
    case "add":
      store.insertFact(incoming);
      return "add";
    case "update":
      store.supersedeFact(candidate.id, now, incoming.tValid);
      store.insertFact(incoming);
      return "update";
    case "delete":
      store.supersedeFact(candidate.id, now, incoming.tValid);
      return "delete";
    case "noop":
      return "noop";
    default: {
      // Exhaustive check — if judge returns unknown action, fall back to ADD
      store.insertFact(incoming);
      return "add";
    }
  }
}

// ── writeFact ─────────────────────────────────────────────────────────────
//
// Thin wrapper that calls reconcileFact. Lives here (not in facts.ts) to
// avoid a state→orchestrator import cycle at runtime.
// The CLI and future consumers import writeFact from this module.

/**
 * Reconcile-then-write a fact. Wall-clock `now` is injected by the caller —
 * this function never reads the clock (mirrors the store's purity contract).
 *
 * The `judge` is optional; when absent the exact-match UPDATE/NOOP paths run
 * deterministically and ambiguous collisions fall back to ADD.
 */
export async function writeFact(
  store: FactStore,
  incoming: FactInput,
  opts: { judge?: FactJudge; now: string },
): Promise<ReconcileAction> {
  return reconcileFact(store, incoming, opts);
}
