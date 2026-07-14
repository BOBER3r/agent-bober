import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { measure, type BenchmarkCase, type FinderFn, type VerifierFn } from "./harness.js";
import { SecurityKnowledgeIndex } from "../index.js";
import { ALL_VULN_CLASSES } from "../../stack-knowledge.js";
import manifest from "./fixtures/manifest.json" with { type: "json" };

const corpus = manifest as BenchmarkCase[];

// A fixed FP subset: safe cases the finder over-flags (deterministic — hardcoded ids, no random).
const FALSE_POSITIVE_SAFE_IDS = new Set(["safe-node-ssrf", "safe-igaming-toctou"]);

// finderFake: critical iff the case is vulnerable OR in the fixed FP subset.
const finderFake: FinderFn = (c) => c.expected === "vulnerable" || FALSE_POSITIVE_SAFE_IDS.has(c.id);

// verifierFake: DOWNGRADE-ONLY (mirrors VerifierResult — may only turn true->false).
// Disproves the safe FP subset (true->false), confirms every vulnerable case.
const verifierFake: VerifierFn = (c, finderCritical) => {
  if (!finderCritical) return false; // never promote
  if (c.expected === "safe" && FALSE_POSITIVE_SAFE_IDS.has(c.id)) return false; // disproved
  return true; // confirmed
};

// ── sc-9-1: corpus counts across the required classes ──────────────────

describe("security benchmark corpus (sc-9-1)", () => {
  it("has >= 12 vulnerable and >= 12 safe cases", () => {
    expect(corpus.filter((c) => c.expected === "vulnerable").length).toBeGreaterThanOrEqual(12);
    expect(corpus.filter((c) => c.expected === "safe").length).toBeGreaterThanOrEqual(12);
  });

  it("covers every required vulnerability class: iGaming money-integrity (TOCTOU, client-odds), " +
    "dex-backend (withdrawal race, decimals, hot-wallet key), injection (SQLi, command, SSRF), " +
    "supply-chain (malicious postinstall), access-control (BOLA)", () => {
    const vulnerableIds = new Set(corpus.filter((c) => c.expected === "vulnerable").map((c) => c.id));
    const requiredIds = [
      "vuln-igaming-toctou",
      "vuln-igaming-client-odds",
      "vuln-dex-withdrawal-race",
      "vuln-dex-decimals",
      "vuln-dex-hotwallet-key",
      "vuln-node-sqli",
      "vuln-node-command-injection",
      "vuln-node-ssrf",
      "vuln-supplychain-postinstall",
      "vuln-node-bola",
    ];
    for (const id of requiredIds) {
      expect(vulnerableIds.has(id), `expected corpus to include "${id}"`).toBe(true);
    }
  });

  it("every case carries non-empty inline code (never a reference to an external file)", () => {
    for (const c of corpus) {
      expect(typeof c.code).toBe("string");
      expect(c.code.length).toBeGreaterThan(0);
    }
  });
});

// ── sc-9-2/sc-9-3: verifier reduces FP-block while retaining recall ────

describe("measure: verifier reduces FP-block while retaining recall (sc-9-2/sc-9-3)", () => {
  it("finder+verifier has strictly lower fpBlockRate and equal-or-higher recall than finder-only", () => {
    const { finderOnly, finderPlusVerifier } = measure(corpus, finderFake, verifierFake);

    // finder-only over-flags the fixed FP subset.
    expect(finderOnly.recall).toBe(1);
    expect(finderOnly.fpBlockRate).toBeGreaterThan(0);

    // finder+verifier disproves the FP subset entirely while keeping every vulnerable critical.
    expect(finderPlusVerifier.fpBlockRate).toBeLessThan(finderOnly.fpBlockRate); // strict reduction
    expect(finderPlusVerifier.recall).toBeGreaterThanOrEqual(finderOnly.recall); // retained detection
    expect(finderPlusVerifier.recall).toBe(1);
    expect(finderPlusVerifier.fpBlockRate).toBe(0);
  });

  it("measure is deterministic — repeated calls over the same inputs return identical results", () => {
    const first = measure(corpus, finderFake, verifierFake);
    const second = measure(corpus, finderFake, verifierFake);
    expect(second).toEqual(first);
  });
});

// ── sc-9-4: every vulnerable label is grounded in a shipped signature ──

describe("every vulnerable label is grounded in a shipped signature (sc-9-4)", () => {
  it("cross-checks signatureId/vulnClass against the parsed SecurityKnowledgeIndex", async () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
    const index = new SecurityKnowledgeIndex(join(repoRoot, "skills"));
    await index.load();
    const byId = new Map(index.all().map((s) => [s.signatureId, s]));

    const vulnerableCases = corpus.filter((c) => c.expected === "vulnerable");
    expect(vulnerableCases.length).toBeGreaterThan(0);

    for (const c of vulnerableCases) {
      if (c.signatureId) {
        // Arm 1: signature-backed classes ground against the parsed skill index.
        const sig = byId.get(c.signatureId);
        expect(sig, `signatureId "${c.signatureId}" (case "${c.id}") not found in the parsed skill index`).toBeDefined();
        expect(sig!.vulnClass).toBe(c.vulnClass); // label consistency with the shipped signature
      } else {
        // Arm 2: scanner-only classes (e.g. supply-chain) have no shipped skill
        // signature — ground on the VulnClass union instead.
        expect(ALL_VULN_CLASSES).toContain(c.vulnClass);
      }
    }
  });

  it("the supply-chain fixture omits signatureId (scanner-emitted class, no shipped skill signature)", () => {
    const supplyChainCase = corpus.find((c) => c.id === "vuln-supplychain-postinstall");
    expect(supplyChainCase).toBeDefined();
    expect(supplyChainCase!.signatureId).toBeUndefined();
    expect(supplyChainCase!.vulnClass).toBe("supply-chain");
  });
});

// ── Optional local real-provider run (sc-9-5, non-CI) ───────────────────
//
// Skipped by default so CI never calls a live provider (nonGoals: "Do not
// require a live LLM in CI"). To run locally against the real finder +
// verifier, set BOBER_BENCHMARK_LIVE=1 and remove the .skip below — see
// fixtures/README.md for the full command and required env (an LLM
// provider API key).
describe.skip("live provider run (manual only, BOBER_BENCHMARK_LIVE=1)", () => {
  it("measures the real runSecurityAudit/runSecurityVerifier over the corpus", () => {
    // Intentionally left as documentation only — see fixtures/README.md for
    // the adapter shape (BenchmarkCase -> AuditDiff) needed to drive the
    // real finder/verifier without a full project checkout.
    expect(true).toBe(true);
  });
});
