import type { VulnClass } from "../../security-audit-types.js";
import type { SecurityStackId } from "../signature.js";

/**
 * Deterministic measurement harness for the security-auditor finder+verifier
 * pipeline (spec-20260714 sprint 9, architecture success criterion #3:
 * "measured, not asserted"). Pure — no fs, no network, no `Math.random`, no
 * `new Date()`/`Date.now()`. Not wired into `runSecurityAudit` or the gate
 * (nonGoals: "not a new blocking gate") — this is a leaf measurement module
 * consumed only by `harness.test.ts`.
 */

/** One labelled benchmark case (mirrors a `fixtures/manifest.json` entry). */
export interface BenchmarkCase {
  /** Stable id, unique in the corpus (used by fakes to pick the FP subset). */
  id: string;
  expected: "vulnerable" | "safe";
  stack: SecurityStackId;
  /** Only meaningful for expected:"vulnerable". Omitted for scanner-only classes (supply-chain). */
  signatureId?: string;
  vulnClass?: VulnClass;
  /** The illustrative snippet — inline, never a separate compiled file. */
  code: string;
}

/** Injected finder: does this case get flagged CRITICAL? (pluggable so CI uses a fake). */
export type FinderFn = (c: BenchmarkCase) => boolean;

/**
 * Injected verifier: given the finder's critical verdict, the post-verify verdict.
 * DOWNGRADE-ONLY, mirroring `VerifierResult` semantics (security-verifier-agent.ts):
 * may only turn true->false (drop/downgrade), never false->true.
 */
export type VerifierFn = (c: BenchmarkCase, finderCritical: boolean) => boolean;

export interface StageMetrics {
  /** vulnerable cases flagged critical / total vulnerable cases (detection retained; higher is better). */
  recall: number;
  /** safe cases flagged critical / total safe cases (false-positive BLOCK rate; lower is better). */
  fpBlockRate: number;
}

export interface MeasureResult {
  finderOnly: StageMetrics;
  finderPlusVerifier: StageMetrics;
}

/** PURE. No fs, no network, NO Math.random, NO new Date(). */
export function measure(corpus: BenchmarkCase[], finderFn: FinderFn, verifierFn: VerifierFn): MeasureResult {
  const vulnerable = corpus.filter((c) => c.expected === "vulnerable");
  const safe = corpus.filter((c) => c.expected === "safe");

  const finderOnly = (c: BenchmarkCase) => finderFn(c);
  const finderPlusVerifier = (c: BenchmarkCase) => verifierFn(c, finderFn(c));

  const rate = (cases: BenchmarkCase[], flag: (c: BenchmarkCase) => boolean) =>
    cases.length === 0 ? 0 : cases.filter(flag).length / cases.length;

  return {
    finderOnly: { recall: rate(vulnerable, finderOnly), fpBlockRate: rate(safe, finderOnly) },
    finderPlusVerifier: { recall: rate(vulnerable, finderPlusVerifier), fpBlockRate: rate(safe, finderPlusVerifier) },
  };
}
