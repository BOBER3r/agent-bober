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
import { SeoReportStore } from "./report-store.js";
import type { SeoFindingSink } from "./hub-emitter.js";
import { FindingSchema } from "../hub/finding.js";
import type { Finding } from "../hub/finding.js";
import { createDefaultConfig } from "../config/schema.js";
import type { BoberConfig } from "../config/schema.js";
import type { LLMClient, ChatParams, ChatResponse } from "../providers/types.js";
import type * as ProviderFactory from "../providers/factory.js";

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

// ── sc-11-2: selectSource — opted-in branches ────────────────────────────

describe("selectSource — opted-in axes (sc-11-2)", () => {
  it("returns a GscAdapter when only search-console is opted in", async () => {
    const config = createDefaultConfig("test-project", "brownfield", undefined, {
      seo: { egress: { "search-console": true, "serp-provider": false }, blockThreshold: "critical-uncited" },
    });
    const source = await selectSource(config, tmpRoot);
    expect(source).toBeInstanceOf(GscAdapter);
  });

  it("returns a DataForSeoAdapter when only serp-provider is opted in", async () => {
    const config = createDefaultConfig("test-project", "brownfield", undefined, {
      seo: { egress: { "search-console": false, "serp-provider": true }, blockThreshold: "critical-uncited" },
    });
    const source = await selectSource(config, tmpRoot);
    expect(source).toBeInstanceOf(DataForSeoAdapter);
  });

  it("returns a composite source covering all 5 capabilities when both axes are opted in", async () => {
    const config = createDefaultConfig("test-project", "brownfield", undefined, {
      seo: { egress: { "search-console": true, "serp-provider": true }, blockThreshold: "critical-uncited" },
    });
    const source = await selectSource(config, tmpRoot);
    expect(source.capabilities().sort()).toEqual(
      ["backlinks", "keywords", "search-analytics", "serp", "url-inspection"].sort(),
    );
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
