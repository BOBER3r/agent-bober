/**
 * Tests for the SEO benchmark harness (spec-20260715-ultimate-seo-suite,
 * Sprint 13, sc-13-1..sc-13-4). Real temp dirs via `mkdtemp` — no fs mocks
 * (principle L44). `createClient` is mocked to a throwing stub so any
 * accidental construction of a real provider fails the test loudly — the
 * harness always injects `dataSource`/`analyzer`/`findingSink`, so
 * `createClient` should NEVER be called (sc-13-4).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runBenchmark, type SeoBenchmarkCase } from "./harness.js";
import manifest from "./corpus/manifest.json" with { type: "json" };
import type * as ProviderFactory from "../../providers/factory.js";

const corpus = manifest as SeoBenchmarkCase[];

// -- createClient mock — MUST NEVER be invoked in this file ---------------

vi.mock("../../providers/factory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderFactory>();
  return {
    ...actual,
    createClient: vi.fn(() => {
      throw new Error("createClient must never be called by the benchmark harness (zero-network, zero-credential run)");
    }),
  };
});

// -- Fixtures ---------------------------------------------------------------

let tmpRootA: string;
let tmpRootB: string;

beforeEach(async () => {
  tmpRootA = await mkdtemp(join(tmpdir(), "bober-seo-benchmark-a-"));
  tmpRootB = await mkdtemp(join(tmpdir(), "bober-seo-benchmark-b-"));
});

afterEach(async () => {
  await rm(tmpRootA, { recursive: true, force: true });
  await rm(tmpRootB, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// -- sc-13-1: labelled corpus shape ─────────────────────────────────────

describe("SEO benchmark corpus (sc-13-1)", () => {
  it("has >= 1 known-good and >= 1 known-bad case", () => {
    expect(corpus.filter((c) => c.label === "known-good").length).toBeGreaterThanOrEqual(1);
    expect(corpus.filter((c) => c.label === "known-bad").length).toBeGreaterThanOrEqual(1);
  });

  it("every expected finding names its workflow (via the case) and an explicit citation-presence flag", () => {
    for (const c of corpus) {
      expect(typeof c.workflow).toBe("string");
      expect(c.workflow.length).toBeGreaterThan(0);
      for (const f of c.expected.findings) {
        expect(f.playbookRef.length).toBeGreaterThan(0);
        expect(typeof f.cited).toBe("boolean");
      }
    }
  });

  it("every case carries a non-empty inline analyzerResponse (never a reference to an external file)", () => {
    for (const c of corpus) {
      expect(typeof c.analyzerResponse).toBe("string");
      expect(c.analyzerResponse.length).toBeGreaterThan(0);
    }
  });

  it("the never-encode known-bad case authors BOTH tactics as uncited (citationUrl empty upstream) so the gate — not a runtime content filter — is what drops them", () => {
    const neverEncodeCase = corpus.find((c) => c.id === "kb-never-encode-uncited");
    expect(neverEncodeCase).toBeDefined();
    expect(neverEncodeCase!.expected.findings.length).toBeGreaterThanOrEqual(2);
    for (const f of neverEncodeCase!.expected.findings) {
      expect(f.cited).toBe(false);
    }
    expect(neverEncodeCase!.analyzerResponse).toMatch(/mass-generate/i);
    expect(neverEncodeCase!.analyzerResponse).toMatch(/purchase links/i);
  });
});

// -- sc-13-2: offline measurement harness reports precision/recall ──────

describe("runBenchmark — precision/recall report (sc-13-2)", () => {
  it("runs the real SeoWorkflowRunner over the whole corpus and reports finite precision/recall in [0,1]", async () => {
    const report = await runBenchmark(corpus, tmpRootA);

    expect(report.cases).toHaveLength(corpus.length);
    for (const metric of [report.findingPrecision, report.findingRecall, report.uncitedDropRecall]) {
      expect(Number.isFinite(metric)).toBe(true);
      expect(metric).toBeGreaterThanOrEqual(0);
      expect(metric).toBeLessThanOrEqual(1);
    }

    // The corpus is authored so every cited expectation is actually emitted
    // and every uncited expectation is actually dropped -- perfect recall.
    expect(report.findingRecall).toBe(1);
  });

  it("kg-technical-audit-cited: the single cited finding reaches the sink, tagged with its playbookRef", async () => {
    const report = await runBenchmark(corpus, tmpRootA);
    const caseResult = report.cases.find((c) => c.id === "kg-technical-audit-cited");

    expect(caseResult).toBeDefined();
    expect(caseResult!.exitCode).toBe(0);
    expect(caseResult!.emitted).toHaveLength(1);
    expect(caseResult!.emitted[0].tags).toContain("playbook:seo.technical-audit.title-tags");
    expect(caseResult!.report?.verdict).toBe("pass");
  });

  it("kg-mixed-cited-and-uncited: only the cited finding reaches the sink; droppedUncited matches expectation", async () => {
    const report = await runBenchmark(corpus, tmpRootA);
    const caseResult = report.cases.find((c) => c.id === "kg-mixed-cited-and-uncited");

    expect(caseResult!.emitted).toHaveLength(1);
    expect(caseResult!.emitted[0].tags).toContain("playbook:seo.technical-audit.canonical-consistency");
    expect(caseResult!.report?.droppedUncited).toBe(1);
    expect(caseResult!.report?.verdict).toBe("pass");
  });

  it("kb-uncited-drop: the critical-severity uncited finding is dropped entirely -- zero sink calls, blocked", async () => {
    const report = await runBenchmark(corpus, tmpRootA);
    const caseResult = report.cases.find((c) => c.id === "kb-uncited-drop");

    expect(caseResult!.emitted).toHaveLength(0);
    expect(caseResult!.report?.droppedUncited).toBe(1);
    expect(caseResult!.report?.verdict).toBe("blocked");
    expect(caseResult!.exitCode).toBe(2);
  });

  it("kb-parse-failure: unparseable analyzer output fails closed -- exitCode 2, no report, zero sink calls", async () => {
    const report = await runBenchmark(corpus, tmpRootA);
    const caseResult = report.cases.find((c) => c.id === "kb-parse-failure");

    expect(caseResult!.exitCode).toBe(2);
    expect(caseResult!.report).toBeUndefined();
    expect(caseResult!.emitted).toHaveLength(0);
  });

  it("kg-ai-visibility-offline: the offline ai-visibility.csv capability is read and the cited finding reaches the sink", async () => {
    const report = await runBenchmark(corpus, tmpRootA);
    const caseResult = report.cases.find((c) => c.id === "kg-ai-visibility-offline");

    expect(caseResult).toBeDefined();
    expect(caseResult!.exitCode).toBe(0);
    expect(caseResult!.emitted).toHaveLength(1);
    expect(caseResult!.emitted[0].tags).toContain("playbook:ai-visibility-branded-mention-audit");
    expect(caseResult!.report?.verdict).toBe("pass");
    expect(caseResult!.report?.dataProvenance.some((p) => p.path?.endsWith("ai-visibility.csv"))).toBe(true);
  });

  it("kg-link-graph-offline: the offline link-graph.csv capability is read and the cited finding reaches the sink", async () => {
    const report = await runBenchmark(corpus, tmpRootA);
    const caseResult = report.cases.find((c) => c.id === "kg-link-graph-offline");

    expect(caseResult).toBeDefined();
    expect(caseResult!.exitCode).toBe(0);
    expect(caseResult!.emitted).toHaveLength(1);
    expect(caseResult!.emitted[0].tags).toContain("playbook:sitefocus-internal-consolidation");
    expect(caseResult!.report?.verdict).toBe("pass");
    expect(caseResult!.report?.dataProvenance.some((p) => p.path?.endsWith("link-graph.csv"))).toBe(true);
  });

  it("kb-never-encode-cited-drop: a never-encode tactic carrying a VALID citation is still dropped -- by the runtime filter, not the citation gate", async () => {
    const report = await runBenchmark(corpus, tmpRootA);
    const caseResult = report.cases.find((c) => c.id === "kb-never-encode-cited-drop");

    expect(caseResult).toBeDefined();
    expect(caseResult!.exitCode).toBe(0);
    expect(caseResult!.emitted).toHaveLength(0);
    expect(caseResult!.report?.droppedNeverEncode).toBe(1);
    expect(caseResult!.report?.droppedUncited).toBe(0);
    expect(caseResult!.report?.verdict).toBe("pass");
  });

  it("kg-liveweight-downgrade: a firm finding grounded in the always-present documented-only generic-floor signature is downgraded to tentative", async () => {
    const report = await runBenchmark(corpus, tmpRootA);
    const caseResult = report.cases.find((c) => c.id === "kg-liveweight-downgrade");

    expect(caseResult).toBeDefined();
    expect(caseResult!.exitCode).toBe(0);
    expect(caseResult!.emitted).toHaveLength(1);
    const downgraded = caseResult!.report?.findings.find((f) => f.playbookRef === "sitefocus-topical-authority");
    expect(downgraded?.confidence).toBe("tentative");
    expect(caseResult!.emitted[0].tags).toContain("confidence:tentative");
    expect(caseResult!.emitted[0].tags).not.toContain("confidence:firm");
  });

  it("is deterministic -- two independent runs over the same corpus yield identical metrics and emitted-finding identities", async () => {
    const first = await runBenchmark(corpus, tmpRootA);
    const second = await runBenchmark(corpus, tmpRootB);

    expect(second.findingPrecision).toBe(first.findingPrecision);
    expect(second.findingRecall).toBe(first.findingRecall);
    expect(second.uncitedDropRecall).toBe(first.uncitedDropRecall);
    expect(second.uncitedReachedSink).toBe(first.uncitedReachedSink);
    expect(second.neverEncodeEmitted).toBe(first.neverEncodeEmitted);

    // Compare emitted-finding identities, NOT report.dataProvenance[].retrievedAt
    // (a wall-clock read inside LocalExportSource -- see harness.ts / pitfalls).
    const identities = (r: typeof first) => r.cases.map((c) => ({ id: c.id, exitCode: c.exitCode, emitted: c.emitted }));
    expect(identities(second)).toEqual(identities(first));
  });
});

// -- sc-13-3: safety invariants across the whole corpus ──────────────────

describe("runBenchmark — safety invariants (sc-13-3)", () => {
  it("zero uncited findings reach the hub across the whole corpus", async () => {
    const report = await runBenchmark(corpus, tmpRootA);
    expect(report.uncitedReachedSink).toBe(0);
  });

  it("zero never-encode tactics are ever emitted across the whole corpus", async () => {
    const report = await runBenchmark(corpus, tmpRootA);
    expect(report.neverEncodeEmitted).toBe(0);
  });

  it("every emitted finding across the corpus carries a well-formed cite: evidence entry", async () => {
    const report = await runBenchmark(corpus, tmpRootA);
    const allEmitted = report.cases.flatMap((c) => c.emitted);
    expect(allEmitted.length).toBeGreaterThan(0);
    for (const finding of allEmitted) {
      const citeEntry = finding.evidence.find((e) => e.startsWith("cite:"));
      expect(citeEntry).toBeDefined();
      expect(() => new URL(citeEntry!.slice("cite:".length))).not.toThrow();
    }
  });
});

// -- sc-13-4: offline, no network, no credentials ────────────────────────

describe("runBenchmark — offline, no network, no credentials (sc-13-4)", () => {
  it("makes zero real network calls and never constructs a real provider client", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await runBenchmark(corpus, tmpRootA);

    expect(fetchSpy).not.toHaveBeenCalled();

    const { createClient } = await import("../../providers/factory.js");
    expect(createClient).not.toHaveBeenCalled();
  });
});
