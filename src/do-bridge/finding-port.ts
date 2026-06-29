import type { Finding } from "../hub/finding.js";
import type { FactStore } from "../state/facts.js";
import { readFindings } from "../hub/finding-store.js";

// ── FindingStore ──────────────────────────────────────────────────────

/**
 * Narrow read-only port for finding lookup.
 * No write path this sprint — the DI core never mutates findings.
 * Sprint 3 may extend this with a writeFinding method for outcome recording.
 */
export interface FindingStore {
  readFinding(id: string): Promise<Finding | null>;
}

// ── FactStoreFindingStore ─────────────────────────────────────────────

/**
 * FactStore-backed adapter for FindingStore.
 *
 * Delegates to readFindings() (src/hub/finding-store.ts:45) — the hub's
 * canonical read path — rather than calling getActiveFacts() directly.
 * There is no single-finding-by-id API in the hub; we filter in-process.
 */
export class FactStoreFindingStore implements FindingStore {
  constructor(private readonly store: FactStore) {}

  async readFinding(id: string): Promise<Finding | null> {
    return readFindings(this.store).find((f) => f.id === id) ?? null;
  }
}

// ── InMemoryFindingStore ──────────────────────────────────────────────

/**
 * In-memory fake for tests — backed by a Map<string, Finding>.
 *
 * Exposes a `writes` array that records any attempted writes so tests can
 * assert zero mutation (sc-1-4). This sprint has no write method, so
 * writes stays empty by construction.
 */
export class InMemoryFindingStore implements FindingStore {
  private readonly map: Map<string, Finding>;

  /**
   * Records any attempted writes (should always be empty this sprint —
   * the FindingStore port has no write path).
   */
  readonly writes: Finding[] = [];

  constructor(seed: Finding[] = []) {
    this.map = new Map(seed.map((f) => [f.id, f]));
  }

  async readFinding(id: string): Promise<Finding | null> {
    return this.map.get(id) ?? null;
  }
}
