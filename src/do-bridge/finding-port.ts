import type { Finding } from "../hub/finding.js";
import type { FactStore } from "../state/facts.js";
import { readFindings, transitionFinding } from "../hub/finding-store.js";
import type { PromotionRef } from "./types.js";
import { serializePromotionRef, parsePromotionRef } from "./types.js";

// ── DoFinding ─────────────────────────────────────────────────────────

/**
 * Do-bridge view of a Finding where promotesTo is a parsed PromotionRef
 * object rather than the raw string stored on disk.
 *
 * FindingSchema.promotesTo is z.string().optional() — the hub schema is NOT
 * modified. This type is owned by the do-bridge port layer; serialization
 * and deserialization happen inside the adapters below.
 */
export type DoFinding = Omit<Finding, "promotesTo"> & {
  promotesTo?: PromotionRef;
};

// ── Internal helpers ──────────────────────────────────────────────────

/**
 * Convert a hub Finding (string promotesTo) to a DoFinding (object promotesTo).
 * If promotesTo is present but unparseable, it is dropped (undefined).
 */
function toDoFinding(f: Finding): DoFinding {
  const ref =
    f.promotesTo !== undefined ? (parsePromotionRef(f.promotesTo) ?? undefined) : undefined;
  return { ...f, promotesTo: ref };
}

// ── FindingStore ──────────────────────────────────────────────────────

/**
 * Narrow port for finding lookup and promotion state writes.
 * Returns DoFinding (promotesTo as structured object) so callers never
 * touch the raw JSON string stored on disk.
 */
export interface FindingStore {
  /** Read a finding by id. Returns null if not found. */
  readFinding(id: string): Promise<DoFinding | null>;

  /**
   * Set promotesTo = ref AND transition status open->in-progress in one call.
   * Returns the updated DoFinding, or null if the id does not exist.
   */
  setPromotion(
    id: string,
    ref: PromotionRef,
    opts: { now: string },
  ): Promise<DoFinding | null>;

  /** Return all findings that currently carry a PromotionRef (promotesTo defined). */
  listPromoted(): Promise<DoFinding[]>;

  /**
   * Transition a finding to an arbitrary status AND overwrite its promotesTo ref,
   * in one supersede-aware write. Used by reconcile for done/open outcomes.
   * Returns the updated DoFinding, or null if the id does not exist.
   */
  applyOutcome(
    id: string,
    status: Finding["status"],
    ref: PromotionRef,
    opts: { now: string },
  ): Promise<DoFinding | null>;
}

// ── FactStoreFindingStore ─────────────────────────────────────────────

/**
 * FactStore-backed adapter for FindingStore.
 *
 * readFinding: delegates to readFindings() (hub's canonical read path) and
 * converts the string promotesTo to a PromotionRef object.
 *
 * setPromotion: serializes the ref to a JSON string, delegates to
 * transitionFinding() (hub's supersede-aware UPDATE path) so bitemporal
 * history is preserved, then converts the result back to DoFinding.
 */
export class FactStoreFindingStore implements FindingStore {
  constructor(private readonly store: FactStore) {}

  async readFinding(id: string): Promise<DoFinding | null> {
    const f = readFindings(this.store).find((f) => f.id === id);
    return f !== undefined ? toDoFinding(f) : null;
  }

  async setPromotion(
    id: string,
    ref: PromotionRef,
    { now }: { now: string },
  ): Promise<DoFinding | null> {
    // Serialize the object ref to the string the hub schema expects on disk.
    const result = await transitionFinding(this.store, id, "in-progress", {
      now,
      mutate: { promotesTo: serializePromotionRef(ref) },
    });
    return result !== null ? toDoFinding(result) : null;
  }

  async listPromoted(): Promise<DoFinding[]> {
    return readFindings(this.store).map(toDoFinding).filter((f) => f.promotesTo !== undefined);
  }

  async applyOutcome(
    id: string,
    status: Finding["status"],
    ref: PromotionRef,
    { now }: { now: string },
  ): Promise<DoFinding | null> {
    const result = await transitionFinding(this.store, id, status, {
      now,
      mutate: { promotesTo: serializePromotionRef(ref) },
    });
    return result !== null ? toDoFinding(result) : null;
  }
}

// ── InMemoryFindingStore ──────────────────────────────────────────────

/**
 * In-memory fake for tests — backed by a Map<string, DoFinding>.
 *
 * setPromotion stores the PromotionRef OBJECT directly (no serialization)
 * so tests can assert promotesTo.runId / promotesTo.status on the result of
 * readFinding without JSON.parse.
 *
 * `writes` records every setPromotion call:
 *  - sc-2-2/2-3: assert writes.length === 1 on approve
 *  - sc-2-4: assert writes.length === 0 on reject
 */
export class InMemoryFindingStore implements FindingStore {
  private readonly map: Map<string, DoFinding>;

  /** Records every setPromotion write. Tests assert .length for mutation count. */
  readonly writes: DoFinding[] = [];

  constructor(seed: Finding[] = []) {
    this.map = new Map(seed.map((f) => [f.id, toDoFinding(f)]));
  }

  async readFinding(id: string): Promise<DoFinding | null> {
    return this.map.get(id) ?? null;
  }

  async setPromotion(
    id: string,
    ref: PromotionRef,
    _opts: { now: string },
  ): Promise<DoFinding | null> {
    const cur = this.map.get(id);
    if (cur === undefined) return null;
    const next: DoFinding = { ...cur, status: "in-progress", promotesTo: ref };
    this.map.set(id, next);
    this.writes.push(next);
    return next;
  }

  async listPromoted(): Promise<DoFinding[]> {
    return [...this.map.values()].filter((f) => f.promotesTo !== undefined);
  }

  async applyOutcome(
    id: string,
    status: Finding["status"],
    ref: PromotionRef,
    _opts: { now: string },
  ): Promise<DoFinding | null> {
    const cur = this.map.get(id);
    if (cur === undefined) return null;
    const next: DoFinding = { ...cur, status, promotesTo: ref };
    this.map.set(id, next);
    this.writes.push(next);
    return next;
  }
}
