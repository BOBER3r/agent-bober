/**
 * Tests for `SeoWorkflowRunner` (spec-20260715-ultimate-seo-suite, Sprint 11,
 * sc-11-1..sc-11-5). Real temp dirs via `mkdtemp` — no fs mocks (principle
 * L44). `createClient` is mocked to a throwing stub so any accidental
 * construction of a real provider fails the test loudly — every test here
 * injects `dataSource` + `analyzer` + `findingSink`, so `createClient`
 * should NEVER be called.
 */
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { SeoWorkflowRunner, selectSource } from "./runner.js";
import { LocalExportSource } from "./sources/local-export.js";
import { GscAdapter } from "./sources/gsc-adapter.js";
import { DataForSeoAdapter } from "./sources/dataforseo-adapter.js";
import { SeoAnalyzer } from "./analyzer.js";
import { SeoReportStore, deriveReportId } from "./report-store.js";
import { SeoQuotaGovernor } from "./quota-governor.js";
import type { SeoFindingSink } from "./hub-emitter.js";
import { FindingSchema } from "../hub/finding.js";
import type { Finding } from "../hub/finding.js";
import { createDefaultConfig } from "../config/schema.js";
import type { BoberConfig } from "../config/schema.js";
import type { LLMClient, ChatParams, ChatResponse } from "../providers/types.js";
import type * as ProviderFactory from "../providers/factory.js";
import type { SeoVerifier } from "./verifier.js";
import type { SeoFinding, DataOutcome } from "./types.js";
import type { SeoDataSource, SeoCapability } from "./data-source.js";

// ── createClient mock — MUST NEVER be invoked in this file ──────────────

vi.mock("../providers/factory.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ProviderFactory>();
  return {
    ...actual,
    createClient: vi.fn(() => {
      throw new Error(
        "createClient must never be called when an analyzer is injected (zero-network test)",
      );
    }),
  };
});

// ── ScriptedClient (mirrors src/seo/analyzer.test.ts) — NO network ──────

class ScriptedClient implements LLMClient {
  readonly calls: ChatParams[] = [];
  private idx = 0;
  constructor(private readonly responses: string[]) {}
  async chat(params: ChatParams): Promise<ChatResponse> {
    this.calls.push(params);
    const text = this.responses[Math.min(this.idx, this.responses.length - 1)] ?? "";
    this.idx += 1;
    return { text, toolCalls: [], stopReason: "end", usage: { inputTokens: 3, outputTokens: 5 } };
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────

let tmpRoot: string;
let fixtureImportDir: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-seo-runner-"));
  fixtureImportDir = join(tmpRoot, "imports");
  await mkdir(fixtureImportDir, { recursive: true });
  await writeFile(
    join(fixtureImportDir, "url-inspection.csv"),
    "url,coverageState\nhttps://example.com/a,Indexed\n",
    "utf-8",
  );
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function baseConfig(): BoberConfig {
  return createDefaultConfig("test-project", "brownfield");
}

const CITED_FINDING_JSON = JSON.stringify({
  findings: [
    {
      recommendation: "De-duplicate the title tag shared by /a and /b.",
      playbookRef: "seo.technical-audit.title-tags",
      citationUrl: "https://developers.google.com/search/docs/appearance/title-link",
      evidence: [
        { metric: "coverageState", value: "Indexed", source: "url-inspection", url: "https://example.com/a" },
      ],
      severity: 3,
      humanApprovalRequired: true,
      confidence: "firm",
    },
  ],
});

const ALL_UNCITED_JSON = JSON.stringify({
  findings: [
    {
      recommendation: "Fix something.",
      playbookRef: "seo.technical-audit.title-tags",
      citationUrl: "",
      evidence: [],
      severity: 5,
      humanApprovalRequired: false,
      confidence: "tentative",
    },
  ],
});

function makeRecordingSink(): { sink: SeoFindingSink; calls: Finding[] } {
  const calls: Finding[] = [];
  const sink: SeoFindingSink = async (f) => {
    calls.push(f);
  };
  return { sink, calls };
}

/**
 * A hand-rolled fake `SeoDataSource` that records exactly how many times
 * each capability method was invoked — used to prove `gatherDataBundle`'s
 * `WORKFLOW_CAPABILITIES` gate omits (never calls) a capability a workflow
 * does not list (sc-9-4), rather than calling-then-discarding it.
 */
function makeSpySource(): { source: SeoDataSource; calls: Record<SeoCapability, number> } {
  const calls: Record<SeoCapability, number> = {
    "search-analytics": 0,
    "url-inspection": 0,
    serp: 0,
    keywords: 0,
    backlinks: 0,
    "ai-visibility": 0,
    "link-graph": 0,
  };
  function dataOutcome<T>(rows: T): DataOutcome<T> {
    return { kind: "data", rows, provenance: { source: "local-export", retrievedAt: "2026-01-01T00:00:00.000Z" } };
  }
  const source: SeoDataSource = {
    capabilities: () => Object.keys(calls) as SeoCapability[],
    searchAnalytics: async () => {
      calls["search-analytics"]++;
      return dataOutcome([]);
    },
    urlInspection: async () => {
      calls["url-inspection"]++;
      return dataOutcome([{ url: "https://example.com/a", coverageState: "Indexed" }]);
    },
    serp: async () => {
      calls.serp++;
      return dataOutcome([]);
    },
    keywords: async () => {
      calls.keywords++;
      return dataOutcome([]);
    },
    backlinks: async () => {
      calls.backlinks++;
      return dataOutcome([]);
    },
    aiVisibility: async () => {
      calls["ai-visibility"]++;
      return dataOutcome([]);
    },
    linkGraph: async () => {
      calls["link-graph"]++;
      return dataOutcome([]);
    },
  };
  return { source, calls };
}

// ── sc-11-1/sc-11-2: offline run (both axes off, injected fakes) ────────

describe("SeoWorkflowRunner.run — offline path (sc-11-1, sc-11-2)", () => {
  it("produces a persisted SeoReport, exitCode 0, and uses ONLY the injected fakes (zero network/LLM)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const scriptedClient = new ScriptedClient([CITED_FINDING_JSON]);
    const analyzer = new SeoAnalyzer(scriptedClient, "test-model");
    const dataSource = new LocalExportSource(fixtureImportDir);
    const { sink, calls } = makeRecordingSink();

    const runner = new SeoWorkflowRunner();
    const outcome = await runner.run({
      projectRoot: tmpRoot,
      config: baseConfig(),
      workflow: "technical-audit",
      target: "example.com",
      now: "2026-07-16T00:00:00.000Z",
      dataSource,
      analyzer,
      findingSink: sink,
    });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.report).toBeDefined();
    expect(outcome.report?.verdict).toBe("pass");
    expect(outcome.report?.findings).toHaveLength(1);
    expect(outcome.report?.droppedUncited).toBe(0);

    // Persisted to disk.
    const store = new SeoReportStore();
    const read = await store.read(tmpRoot, outcome.report!.reportId);
    expect(read).toEqual(outcome.report);

    // The injected ScriptedClient (not a real provider) was used exactly once.
    expect(scriptedClient.calls).toHaveLength(1);

    // Zero real network: no fetch call opened.
    expect(fetchSpy).not.toHaveBeenCalled();

    // createClient (real provider construction) was never called.
    const { createClient } = await import("../providers/factory.js");
    expect(createClient).not.toHaveBeenCalled();

    // The cited finding reached the sink and validates against FindingSchema.
    expect(calls).toHaveLength(1);
    expect(() => FindingSchema.parse(calls[0])).not.toThrow();
    expect(calls[0].domain).toBe("seo");
  });

  it("maps a humanApprovalRequired finding to hub Finding kind 'action' (sc-11-4)", async () => {
    const analyzer = new SeoAnalyzer(new ScriptedClient([CITED_FINDING_JSON]), "test-model");
    const { sink, calls } = makeRecordingSink();

    const runner = new SeoWorkflowRunner();
    await runner.run({
      projectRoot: tmpRoot,
      config: baseConfig(),
      workflow: "technical-audit",
      target: "example.com",
      now: "2026-07-16T00:00:00.000Z",
      dataSource: new LocalExportSource(fixtureImportDir),
      analyzer,
      findingSink: sink,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].kind).toBe("action");
  });

  it("selectSource: both egress axes off (default) returns a LocalExportSource", async () => {
    const source = await selectSource(baseConfig(), tmpRoot);
    expect(source).toBeInstanceOf(LocalExportSource);
  });
});

// ── sc-9-1/sc-9-3: selectSource — opted-in branches now return a
// ── CapabilitySeoRouter (not a raw GscAdapter/DataForSeoAdapter) ─────────

describe("selectSource — opted-in axes (sc-9-1, sc-9-3)", () => {
  it("returns a router serving ONLY search-analytics/url-inspection when only search-console is opted in", async () => {
    const config = createDefaultConfig("test-project", "brownfield", undefined, {
      seo: { egress: { "search-console": true, "serp-provider": false }, blockThreshold: "critical-uncited" },
    });
    const source = await selectSource(config, tmpRoot);
    // The router wraps GscAdapter — it is no longer the raw class itself
    // (CapabilitySeoRouter replaces CompositeSeoSource, sc-9-1).
    expect(source).not.toBeInstanceOf(GscAdapter);
    expect(source).not.toBeInstanceOf(LocalExportSource);
    expect(source.capabilities().sort()).toEqual(["search-analytics", "url-inspection"].sort());
    // Unrouted capabilities resolve `disabled` — the router never throws (sc-9-1).
    await expect(source.serp({ keyword: "x", location: "us" })).resolves.toEqual({ kind: "disabled" });
    await expect(source.keywords({ keywords: ["x"], location: "us" })).resolves.toEqual({ kind: "disabled" });
    await expect(source.backlinks({ target: "x" })).resolves.toEqual({ kind: "disabled" });
    await expect(source.aiVisibility({ target: "x", prompts: ["x"] })).resolves.toEqual({ kind: "disabled" });
    await expect(source.linkGraph({ rootUrl: "x" })).resolves.toEqual({ kind: "disabled" });
  });

  it("returns a router serving ONLY serp/keywords/backlinks when only serp-provider is opted in", async () => {
    const config = createDefaultConfig("test-project", "brownfield", undefined, {
      seo: { egress: { "search-console": false, "serp-provider": true }, blockThreshold: "critical-uncited" },
    });
    const source = await selectSource(config, tmpRoot);
    expect(source).not.toBeInstanceOf(DataForSeoAdapter);
    expect(source).not.toBeInstanceOf(LocalExportSource);
    expect(source.capabilities().sort()).toEqual(["backlinks", "keywords", "serp"].sort());
    await expect(source.searchAnalytics({ siteUrl: "x", startDate: "d", endDate: "d", dimensions: [] })).resolves.toEqual({
      kind: "disabled",
    });
    await expect(source.urlInspection({ siteUrl: "x", inspectionUrl: "x" })).resolves.toEqual({ kind: "disabled" });
    await expect(source.linkGraph({ rootUrl: "x" })).resolves.toEqual({ kind: "disabled" });
  });

  it("returns a router covering all 5 original capabilities when both search-console and serp-provider are opted in", async () => {
    const config = createDefaultConfig("test-project", "brownfield", undefined, {
      seo: { egress: { "search-console": true, "serp-provider": true }, blockThreshold: "critical-uncited" },
    });
    const source = await selectSource(config, tmpRoot);
    expect(source.capabilities().sort()).toEqual(
      ["backlinks", "keywords", "search-analytics", "serp", "url-inspection"].sort(),
    );
  });
});

// ── sc-9-2: selectSource — all-four-axes-off zero-construction ──────────

describe("selectSource — all-four-axes-off zero-construction (sc-9-2)", () => {
  it("returns a LocalExportSource; no governor is loaded, no socket opens", async () => {
    const loadSpy = vi.spyOn(SeoQuotaGovernor, "load");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const source = await selectSource(baseConfig(), tmpRoot);

    expect(source).toBeInstanceOf(LocalExportSource);
    // The LocalExportSource `return` is the FIRST statement after the
    // all-off predicate, strictly before `SeoQuotaGovernor.load` — no
    // governor/ledger is ever constructed on this path (Pitfall 2).
    expect(loadSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── sc-9-2/sc-9-3: per-axis route assembly + zero-network-when-unused ───

describe("selectSource — route assembly (sc-9-2, sc-9-3, ADR-8/ADR-10)", () => {
  it("only ai-visibility on: routes ONLY ai-visibility; every other capability disabled; zero network", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const config = createDefaultConfig("test-project", "brownfield", undefined, {
      seo: { egress: { "ai-visibility": true }, blockThreshold: "critical-uncited" },
    });

    const source = await selectSource(config, tmpRoot);

    expect(source.capabilities()).toEqual(["ai-visibility"]);
    const disabledOutcomes = await Promise.all([
      source.searchAnalytics({ siteUrl: "x", startDate: "d", endDate: "d", dimensions: [] }),
      source.urlInspection({ siteUrl: "x", inspectionUrl: "x" }),
      source.serp({ keyword: "x", location: "us" }),
      source.keywords({ keywords: ["x"], location: "us" }),
      source.backlinks({ target: "x" }),
      source.linkGraph({ rootUrl: "x" }),
    ]);
    for (const outcome of disabledOutcomes) {
      expect(outcome).toEqual({ kind: "disabled" });
    }
    // ai-visibility is routed to the offline LocalExportSource arm (no live
    // provider is pinned, sprint briefing §9) — zero network either way.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("only site-crawl on: routes url-inspection (fallback), link-graph, and serp; NOT search-analytics/keywords/backlinks", async () => {
    const config = createDefaultConfig("test-project", "brownfield", undefined, {
      seo: { egress: { "site-crawl": true }, blockThreshold: "critical-uncited" },
    });
    const source = await selectSource(config, tmpRoot);
    expect(source.capabilities().sort()).toEqual(["link-graph", "serp", "url-inspection"].sort());
  });

  it("search-console + site-crawl both on: url-inspection dispatches to GscAdapter, not CrawlSource (ADR-8 GSC wins)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    } as unknown as Response);
    const config = createDefaultConfig("test-project", "brownfield", undefined, {
      seo: { egress: { "search-console": true, "site-crawl": true }, blockThreshold: "critical-uncited" },
    });
    const source = await selectSource(config, tmpRoot);

    const caps = source.capabilities();
    expect(caps.filter((c) => c === "url-inspection")).toHaveLength(1); // present exactly once
    expect(caps).toContain("link-graph");
    expect(caps).toContain("search-analytics");

    // `gsc-http-500` is a reason literal ONLY GscAdapter produces
    // (dataforseo-adapter's/crawl-source's abstain reasons never match this
    // string) — proves GSC, not CrawlSource, served this call.
    const outcome = await source.urlInspection({ siteUrl: "https://example.com", inspectionUrl: "https://example.com/a" });
    expect(outcome).toEqual({ kind: "abstain", reason: "gsc-http-500" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

// ── sc-9-4: gatherDataBundle + WORKFLOW_CAPABILITIES — metered omission ──

describe("gatherDataBundle / WORKFLOW_CAPABILITIES — metered omission (sc-9-4)", () => {
  it("technical-audit run never probes the metered ai-visibility capability (stopCondition)", async () => {
    const { source, calls } = makeSpySource();
    const analyzer = new SeoAnalyzer(new ScriptedClient([CITED_FINDING_JSON]), "test-model");
    const { sink } = makeRecordingSink();

    const runner = new SeoWorkflowRunner();
    const outcome = await runner.run({
      projectRoot: tmpRoot,
      config: baseConfig(),
      workflow: "technical-audit",
      target: "example.com",
      now: "2026-07-16T00:00:00.000Z",
      dataSource: source,
      analyzer,
      findingSink: sink,
    });

    expect(outcome.exitCode).toBe(0);
    // CORE — always gathered for technical-audit.
    expect(calls["search-analytics"]).toBe(1);
    expect(calls["url-inspection"]).toBe(1);
    expect(calls.serp).toBe(1);
    expect(calls.keywords).toBe(1);
    expect(calls.backlinks).toBe(1);
    // Omitted for technical-audit — NEVER called (not called-then-discarded).
    expect(calls["ai-visibility"]).toBe(0);
    expect(calls["link-graph"]).toBe(0);
  });

  it("the ai-visibility workflow DOES probe ai-visibility exactly once", async () => {
    const { source, calls } = makeSpySource();
    const analyzer = new SeoAnalyzer(new ScriptedClient([CITED_FINDING_JSON]), "test-model");
    const { sink } = makeRecordingSink();

    const runner = new SeoWorkflowRunner();
    await runner.run({
      projectRoot: tmpRoot,
      config: baseConfig(),
      workflow: "ai-visibility",
      target: "example.com",
      now: "2026-07-16T00:00:00.000Z",
      dataSource: source,
      analyzer,
      findingSink: sink,
    });

    expect(calls["ai-visibility"]).toBe(1);
  });

  it("the internal-linking workflow probes link-graph exactly once and never probes ai-visibility", async () => {
    const { source, calls } = makeSpySource();
    const analyzer = new SeoAnalyzer(new ScriptedClient([CITED_FINDING_JSON]), "test-model");
    const { sink } = makeRecordingSink();

    const runner = new SeoWorkflowRunner();
    await runner.run({
      projectRoot: tmpRoot,
      config: baseConfig(),
      workflow: "internal-linking",
      target: "example.com",
      now: "2026-07-16T00:00:00.000Z",
      dataSource: source,
      analyzer,
      findingSink: sink,
    });

    expect(calls["link-graph"]).toBe(1);
    expect(calls["ai-visibility"]).toBe(0);
  });
});

// ── sc-9-5: full offline golden report — byte-identical-when-off ────────

describe("SeoWorkflowRunner.run — full offline golden report (sc-9-5)", () => {
  it("technical-audit offline report is unchanged by the Sprint 9 routing/gathering changes", async () => {
    const analyzer = new SeoAnalyzer(new ScriptedClient([CITED_FINDING_JSON]), "test-model");
    const { sink, calls } = makeRecordingSink();

    const runner = new SeoWorkflowRunner();
    const outcome = await runner.run({
      projectRoot: tmpRoot,
      config: baseConfig(),
      workflow: "technical-audit",
      target: "example.com",
      now: "2026-07-16T00:00:00.000Z",
      dataSource: new LocalExportSource(fixtureImportDir),
      analyzer,
      findingSink: sink,
    });

    expect(outcome.exitCode).toBe(0);
    // Deep-equal against the full report shape — `retrievedAt`/`path`/
    // `mtimeMs` are the ONLY fields left flexible (real wall-clock/fs stat
    // values, orthogonal to this sprint's routing/gathering change); every
    // other field is pinned to prove the report is byte-identical to before
    // this sprint for an unchanged (all-axes-off, CORE-only) workflow.
    expect(outcome.report).toEqual({
      reportId: deriveReportId("2026-07-16T00:00:00.000Z", "technical-audit", "example.com"),
      workflow: "technical-audit",
      target: "example.com",
      generatedAt: "2026-07-16T00:00:00.000Z",
      findings: [
        {
          recommendation: "De-duplicate the title tag shared by /a and /b.",
          workflow: "technical-audit",
          playbookRef: "seo.technical-audit.title-tags",
          citationUrl: "https://developers.google.com/search/docs/appearance/title-link",
          evidence: [
            { metric: "coverageState", value: "Indexed", source: "url-inspection", url: "https://example.com/a" },
          ],
          severity: 3,
          humanApprovalRequired: true,
          confidence: "firm",
        },
      ],
      droppedUncited: 0,
      droppedNeverEncode: 0,
      dataProvenance: [
        {
          source: "local-export",
          retrievedAt: expect.any(String),
          path: expect.stringContaining("url-inspection.csv"),
          mtimeMs: expect.any(Number),
        },
      ],
      verdict: "pass",
    });
    expect(calls).toHaveLength(1);
  });
});

// ── spec-20260717-seo-improver-builder, Sprint 2: NeverEncodeFilter wired
// ── ahead of the citation gate (sc-2-3) ─────────────────────────────────

const NEVER_ENCODE_CITED_JSON = JSON.stringify({
  findings: [
    {
      recommendation: "Place a parasite page on a high-authority host to rank for our terms.",
      playbookRef: "seo.parasite-watch.parasite-placement",
      citationUrl: "https://developers.google.com/search/docs/essentials/spam-policies", // well-formed
      evidence: [],
      severity: 4,
      humanApprovalRequired: false,
      confidence: "tentative",
    },
  ],
});

describe("SeoWorkflowRunner.run — NeverEncodeFilter runs before the citation gate (sc-2-3)", () => {
  it("drops a never-encode tactic that carries a valid citation BEFORE the gate", async () => {
    const analyzer = new SeoAnalyzer(new ScriptedClient([NEVER_ENCODE_CITED_JSON]), "test-model");
    const { sink, calls } = makeRecordingSink();

    const runner = new SeoWorkflowRunner();
    const outcome = await runner.run({
      projectRoot: tmpRoot,
      config: baseConfig(),
      workflow: "parasite-watch",
      target: "example.com",
      now: "2026-07-16T00:00:00.000Z",
      dataSource: new LocalExportSource(fixtureImportDir),
      analyzer,
      findingSink: sink,
    });

    expect(outcome.report?.droppedNeverEncode).toBe(1);
    expect(outcome.report?.findings).toHaveLength(0);
    // Never reached the citation gate at all — droppedUncited stays 0.
    expect(outcome.report?.droppedUncited).toBe(0);
    // Never reached the hub.
    expect(calls).toHaveLength(0);
  });
});

// ── sc-11-5: uncited findings never reach the hub ────────────────────────

describe("SeoWorkflowRunner.run — uncited findings never reach the hub (sc-11-5)", () => {
  it("all-uncited findings -> zero sink calls", async () => {
    const analyzer = new SeoAnalyzer(new ScriptedClient([ALL_UNCITED_JSON]), "test-model");
    const { sink, calls } = makeRecordingSink();

    const runner = new SeoWorkflowRunner();
    const outcome = await runner.run({
      projectRoot: tmpRoot,
      config: baseConfig(),
      workflow: "technical-audit",
      target: "example.com",
      now: "2026-07-16T00:00:00.000Z",
      dataSource: new LocalExportSource(fixtureImportDir),
      analyzer,
      findingSink: sink,
    });

    expect(calls).toHaveLength(0);
    expect(outcome.report?.droppedUncited).toBe(1);
    expect(outcome.report?.findings).toHaveLength(0);
    // severity 5 uncited finding blocks under the default "critical-uncited" threshold.
    expect(outcome.report?.verdict).toBe("blocked");
    expect(outcome.exitCode).toBe(2);
  });
});

// ── sc-11-1/sc-11-5: analyzer parsed:false -> exitCode 2, zero emits ────

describe("SeoWorkflowRunner.run — fail-closed on unparseable analysis (sc-11-1, sc-11-5)", () => {
  it("parsed:false -> exitCode 2, no report persisted, zero hub emits", async () => {
    const analyzer = new SeoAnalyzer(new ScriptedClient(["not valid json at all"]), "test-model");
    const { sink, calls } = makeRecordingSink();

    const runner = new SeoWorkflowRunner();
    const outcome = await runner.run({
      projectRoot: tmpRoot,
      config: baseConfig(),
      workflow: "technical-audit",
      target: "example.com",
      now: "2026-07-16T00:00:00.000Z",
      dataSource: new LocalExportSource(fixtureImportDir),
      analyzer,
      findingSink: sink,
    });

    expect(outcome.exitCode).toBe(2);
    expect(outcome.report).toBeUndefined();
    expect(calls).toHaveLength(0);

    const store = new SeoReportStore();
    expect(await store.list(tmpRoot)).toEqual([]);
  });
});

// ── Never throws ─────────────────────────────────────────────────────

describe("SeoWorkflowRunner.run — never throws", () => {
  it("resolves exitCode 2 when the injected analyzer rejects (transport error)", async () => {
    const failingAnalyzer = {
      analyze: () => Promise.reject(new Error("transport error")),
    } as unknown as SeoAnalyzer;

    const runner = new SeoWorkflowRunner();
    await expect(
      runner.run({
        projectRoot: tmpRoot,
        config: baseConfig(),
        workflow: "technical-audit",
        target: "example.com",
        now: "2026-07-16T00:00:00.000Z",
        dataSource: new LocalExportSource(fixtureImportDir),
        analyzer: failingAnalyzer,
      }),
    ).resolves.toEqual({ exitCode: 2 });
  });

  it("resolves exitCode 2 when the injected findingSink throws (hub failure never changes exit code) but still persists the report", async () => {
    const analyzer = new SeoAnalyzer(new ScriptedClient([CITED_FINDING_JSON]), "test-model");
    const throwingSink: SeoFindingSink = async () => {
      throw new Error("hub down");
    };

    const runner = new SeoWorkflowRunner();
    const outcome = await runner.run({
      projectRoot: tmpRoot,
      config: baseConfig(),
      workflow: "technical-audit",
      target: "example.com",
      now: "2026-07-16T00:00:00.000Z",
      dataSource: new LocalExportSource(fixtureImportDir),
      analyzer,
      findingSink: throwingSink,
    });

    // A hub sink failure is swallowed inside SeoHubEmitter.emit — it must
    // NEVER change the exit code computed from the citation gate.
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report).toBeDefined();
  });
});

// ── Sprint 12: opt-in adversarial verifier stage (sc-12-2, sc-12-4) ─────

function verifierEnabledConfig(): BoberConfig {
  return createDefaultConfig("test-project", "brownfield", undefined, {
    seo: { verifier: { enabled: true }, blockThreshold: "critical-uncited" },
  });
}

describe("SeoWorkflowRunner.run — opt-in verifier stage (sc-12-2, sc-12-4)", () => {
  it("verifier disabled -> byte-identical to the no-verifier run: verifier NEVER invoked, findings unchanged", async () => {
    const analyzer = new SeoAnalyzer(new ScriptedClient([CITED_FINDING_JSON]), "test-model");
    const { sink, calls } = makeRecordingSink();
    const spyVerifier: SeoVerifier = { verify: vi.fn(async ({ findings }) => ({ ran: true, findings })) };

    const runner = new SeoWorkflowRunner();
    const outcome = await runner.run({
      projectRoot: tmpRoot,
      config: baseConfig(), // `seo` omitted entirely -> verifier.enabled defaults false
      workflow: "technical-audit",
      target: "example.com",
      now: "2026-07-16T00:00:00.000Z",
      dataSource: new LocalExportSource(fixtureImportDir),
      analyzer,
      findingSink: sink,
      verifier: spyVerifier,
    });

    // The runner must not even CALL the injected verifier when disabled
    // (Pattern E) — this is the "no provider call" half of sc-12-2.
    expect(spyVerifier.verify).not.toHaveBeenCalled();

    expect(outcome.exitCode).toBe(0);
    expect(outcome.report).toBeDefined();
    expect(outcome.report?.verdict).toBe("pass");
    expect(outcome.report?.findings).toHaveLength(1);
    expect(outcome.report!.findings[0].severity).toBe(3); // byte-identical to CITED_FINDING_JSON, untouched
    expect(calls).toHaveLength(1);
  });

  it("verifier enabled + stub downgrades -> report.findings severity lowered; exit code still derives from the citation gate alone", async () => {
    const analyzer = new SeoAnalyzer(new ScriptedClient([CITED_FINDING_JSON]), "test-model");
    const { sink, calls } = makeRecordingSink();
    const stubVerifier: SeoVerifier = {
      verify: vi.fn(async ({ findings }) => ({
        ran: true,
        findings: findings.map((f) => ({
          ...f,
          severity: Math.max(1, f.severity - 1) as SeoFinding["severity"],
        })),
      })),
    };

    const runner = new SeoWorkflowRunner();
    const outcome = await runner.run({
      projectRoot: tmpRoot,
      config: verifierEnabledConfig(),
      workflow: "technical-audit",
      target: "example.com",
      now: "2026-07-16T00:00:00.000Z",
      dataSource: new LocalExportSource(fixtureImportDir),
      analyzer,
      findingSink: sink,
      verifier: stubVerifier,
    });

    expect(stubVerifier.verify).toHaveBeenCalledTimes(1);
    expect(outcome.report?.findings).toHaveLength(1);
    expect(outcome.report!.findings[0].severity).toBe(2); // 3 -> 2, downgraded by the stub
    // gate.blocked (and therefore exitCode) is derived from the citation
    // gate ALONE and is unaffected by the verifier's downgrade.
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report?.verdict).toBe("pass");
    // Hub emit received the verifier-folded (downgraded) finding.
    expect(calls).toHaveLength(1);
  });

  it("verifier enabled but returns ran:false (fail-closed) -> findings/exitCode/hub emit unaffected (sc-12-4)", async () => {
    const analyzer = new SeoAnalyzer(new ScriptedClient([CITED_FINDING_JSON]), "test-model");
    const { sink, calls } = makeRecordingSink();
    const failClosedVerifier: SeoVerifier = {
      verify: vi.fn(async ({ findings }) => ({ ran: false, findings })),
    };

    const runner = new SeoWorkflowRunner();
    const outcome = await runner.run({
      projectRoot: tmpRoot,
      config: verifierEnabledConfig(),
      workflow: "technical-audit",
      target: "example.com",
      now: "2026-07-16T00:00:00.000Z",
      dataSource: new LocalExportSource(fixtureImportDir),
      analyzer,
      findingSink: sink,
      verifier: failClosedVerifier,
    });

    expect(failClosedVerifier.verify).toHaveBeenCalledTimes(1);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report?.findings).toHaveLength(1);
    expect(outcome.report!.findings[0].severity).toBe(3); // unchanged — fail-closed
    expect(calls).toHaveLength(1);
  });
});
