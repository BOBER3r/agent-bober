// Source-of-truth graph types for the harness integration.
// Mirrors arch-20260524-port-code-review-graph-architecture.md §Data Model.

import type { z } from "zod";
import type { GraphSectionSchema } from "../config/schema.js";

export type GraphSection = z.infer<typeof GraphSectionSchema>;

export type PrereqResult =
  | { ok: true; version: string }
  | { ok: false; reason: "MISSING" | "INCOMPATIBLE"; hint: string };

export type GraphManifest = {
  schemaVersion: 1;
  tokensaveVersion: string;
  createdAt: string;
  lastSyncAt: string;
  indexedFileCount: number;
  languageTier: string;
  lastSyncedHeadSha: string | null;
  pendingFiles: string[];
};

export type StalenessVerdict =
  | { stale: false }
  | {
      stale: true;
      reason: "HEAD_DIFFERS" | "NEWER_MTIME" | "NO_MANIFEST";
      detail: string;
      newerFiles?: string[];
    };

// ── Graph result contract (ADR-3) ──────────────────────────────────

/** Discriminated union for all GraphClient method returns. ADR-3. */
export type GraphResult<T> =
  | {
      ok: true;
      data: T;
      // TODO(phase-2): 'binding' kicks in when EngineBinding ships (0.14.0+).
      backend: "mcp" | "binding";
      durationMs: number;
      /** Present only when manifest is stale. Stale data is still data. */
      stale?: true;
    }
  | { ok: false; reason: GraphFailureReason; detail: string };

/** Exhaustive set of graph failure modes. Extending this requires a new
 *  case in every `switch (reason)` — assertNever enforces this at compile time. */
export type GraphFailureReason =
  | "GRAPH_DISABLED"
  | "GRAPH_UNAVAILABLE"
  | "GRAPH_STALE"
  | "GRAPH_TIMEOUT"
  | "GRAPH_ERROR";

// ── Graph data model (architecture doc §Data Model) ────────────────

export type NodeRef = {
  id: string;
  kind: "function" | "class" | "module" | "symbol";
  file: string;
  line: number;
  symbol: string;
};

export type SearchHit = {
  node: NodeRef;
  score: number;
  snippet: string;
};

export type ImpactReport = {
  root: NodeRef;
  affected: NodeRef[];
  testsAffected: NodeRef[];
};

export type FallbackHint = {
  message: string;
  suggestedTools: string[];
  retryable: boolean;
};

// ── Prefetch ───────────────────────────────────────────────────────

export type PrefetchOp =
  | "search"
  | "query"
  | "impact"
  | "reviewContext"
  | "overview"
  | "changes";

export type PrefetchSpec = {
  key: string;
  op: PrefetchOp;
  /** Op-specific args; GraphClient.prefetch dispatches by `op`. */
  args: unknown;
};

// ── Exhaustiveness helper ──────────────────────────────────────────

/**
 * Use as `default: return assertNever(reason);` in switch statements
 * over discriminated unions. If a new variant is added without a case,
 * `tsc --noEmit` fails because the discriminator is no longer `never`.
 */
export function assertNever(x: never): never {
  throw new Error(`Unreachable: ${JSON.stringify(x)}`);
}
