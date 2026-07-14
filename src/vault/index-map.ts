/**
 * index-map — PURE mapping from a VaultNote's frontmatter to FactInput records.
 *
 * PURE: Never calls Date.now() or new Date() — timestamps are injected via `opts.now`.
 *       Never touches the filesystem — no fs or network imports.
 *
 * bober: one FactInput per frontmatter key; empty-stringified values are skipped
 *        to satisfy FactSchema's value.min(1) constraint. Arrays/objects use
 *        JSON.stringify for stable deterministic ids.
 */

import type { VaultNote } from "./types.js";
import type { FactInput } from "../state/facts.js";

// ── Value stringification ───────────────────────────────────────────────────

/**
 * Stringify a frontmatter value stably so identical input yields identical fact ids.
 * Scalars use String() which is stable and lossless for primitives.
 * Arrays/objects use JSON.stringify so deterministic fact ids stay stable across runs.
 */
function stringifyValue(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null || v === undefined) return "";
  return JSON.stringify(v);
}

// ── Mapping ──────────────────────────────────────────────────────────────────

/**
 * Map a single VaultNote to one FactInput per frontmatter key.
 *
 * subject resolution:
 *   - frontmatter.id (as string) if present and non-empty
 *   - otherwise: note.path
 *
 * value stringification:
 *   - string scalars: as-is
 *   - number/boolean: String()
 *   - arrays/objects: JSON.stringify (stable, preserves structure)
 *   - empty-stringified values are SKIPPED (FactSchema value.min(1))
 *
 * status:superseded filtering belongs in reindexNotes, NOT here.
 * This function maps ALL keys unconditionally.
 */
export function noteToFacts(
  note: VaultNote,
  opts: { scope: string; now: string; sourceRunId?: string | null },
): FactInput[] {
  const subject =
    typeof note.frontmatter.id === "string" && note.frontmatter.id.length > 0
      ? note.frontmatter.id
      : note.path;

  const facts: FactInput[] = [];
  for (const [key, val] of Object.entries(note.frontmatter)) {
    const value = stringifyValue(val);
    if (value.length === 0) continue; // guard against FactSchema value.min(1)
    facts.push({
      scope: opts.scope,
      subject,
      predicate: key,
      value,
      confidence: 1,
      sourceRunId: opts.sourceRunId ?? null,
      tValid: opts.now,
      tCreated: opts.now,
    });
  }
  return facts;
}

// ── Sprint 5 convergence: canonical status lives in conventions.ts ───────────
export { SUPERSEDED_STATUS } from "./conventions.js";
