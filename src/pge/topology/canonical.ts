import { createHash } from "node:crypto";
import type { TopologySpec } from "../../contracts/topology.js";

/**
 * Canonical form and checksum for a topology artifact.
 *
 * PURE. No filesystem, no process, no network, no clock. The ESLint boundary on
 * `src/pge/topology/**` and on the layer's shared root `src/contracts/topology.ts`
 * forbids importing any executor — including via the root barrel or a process spawn —
 * so this module cannot transitively reach one.
 */

// ── Canonical ordering ──────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readSortKey(entry: unknown, field: string): string | undefined {
  if (!isPlainObject(entry)) return undefined;
  const raw = entry[field];
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Arrays are ordered deterministically:
 *  - arrays of objects carrying `id`    → sorted by `id`    (nodes, edges, channels, subgraphs)
 *  - arrays of objects carrying `key`   → sorted by `key`   (ports)
 *  - arrays of objects carrying `label` → sorted by `label` (router targets)
 *  - arrays of primitives               → sorted lexicographically (reads, writes, effects)
 *  - anything else                      → left in authored order
 */
function sortCanonicalArray(items: unknown[]): unknown[] {
  if (items.length < 2) return items;

  for (const field of ["id", "key", "label"] as const) {
    if (items.every((item) => readSortKey(item, field) !== undefined)) {
      return [...items].sort((a, b) => {
        const left = readSortKey(a, field) as string;
        const right = readSortKey(b, field) as string;
        return left < right ? -1 : left > right ? 1 : 0;
      });
    }
  }

  if (items.every((item) => item === null || typeof item !== "object")) {
    return [...items].sort((a, b) => {
      const left = String(a);
      const right = String(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  }

  return items;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return sortCanonicalArray(value.map(canonicalValue));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child === undefined) continue;
      out[key] = canonicalValue(child);
    }
    return out;
  }
  return value;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Deterministic string form of a topology: object keys sorted, arrays ordered by
 * intrinsic key, `undefined` members dropped, and the `checksum` field ELIDED so the
 * checksum can be computed over the artifact that carries it.
 */
export function canonicalize(spec: TopologySpec): string {
  const { checksum: _checksum, ...rest } = spec;
  return JSON.stringify(canonicalValue(rest));
}

/** `sha256:<64 lowercase hex>` over {@link canonicalize}. Pure. */
export function checksumTopology(spec: TopologySpec): `sha256:${string}` {
  const digest = createHash("sha256").update(canonicalize(spec), "utf8").digest("hex");
  return `sha256:${digest}`;
}

/** True when the artifact's stored `checksum` matches its canonical form. */
export function checksumMatches(spec: TopologySpec): boolean {
  return spec.checksum === checksumTopology(spec);
}
