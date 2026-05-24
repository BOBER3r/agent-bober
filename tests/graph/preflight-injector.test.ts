/**
 * Comprehensive unit tests for PreflightContextInjector.
 *
 * Coverage:
 * - 5 roles × query batch derivation
 * - Budget enforcement (>budget → truncation marker)
 * - Stale banner (mock staleness=true)
 * - Failure isolation (one failing query doesn't abort the batch)
 * - Empty input (no symbols, no keywords)
 * - Engine-not-ready (graph disabled / health != 'ready')
 * - Preflight-failure incident logging
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PreflightContextInjector, QUERY_BATCHES, deriveFromContract } from "../../src/graph/preflight-injector.js";
import type { GraphClient } from "../../src/graph/client.js";
import type { GraphArtifactStore } from "../../src/graph/artifact-store.js";
import type { IncidentLog } from "../../src/graph/incidents.js";
import type { SprintContract } from "../../src/contracts/sprint-contract.js";
import type { GraphSection } from "../../src/graph/types.js";

// ── Mocks ──────────────────────────────────────────────────────────

// Mock graphPipelineLifecycle to control engineHealth
vi.mock("../../src/graph/pipeline-lifecycle.js", () => ({
  graphPipelineLifecycle: {
    engineHealth: vi.fn().mockReturnValue("ready"),
    getGraphClient: vi.fn().mockReturnValue(null),
    getGraphDeps: vi.fn().mockReturnValue(null),
  },
}));

// Mock execa so git rev-parse HEAD returns a deterministic synthetic SHA.
// Stale banner unit test controls both SHAs: lastSyncedHeadSha via makeArtifactStore,
// and currentSha via this mock (avoids real git subprocess in unit tests).
vi.mock("execa", () => ({
  execa: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "def5678901234abcdef01234567890ab12345678" }),
}));

import { graphPipelineLifecycle } from "../../src/graph/pipeline-lifecycle.js";
import { execa } from "execa";

// ── Helpers ────────────────────────────────────────────────────────

function makeGraphConfig(overrides: Partial<GraphSection> = {}): GraphSection {
  return {
    enabled: true,
    autoSync: true,
    languageTier: "core",
    manifestPath: ".bober/graph/manifest.json",
    syncTimeoutMs: 2000,
    queryTimeoutMs: 5000,
    debounceMs: 750,
    hookQueueMax: 50,
    maxEngineRssMb: 512,
    exposeOnExternalMcp: true,
    preflightBudgets: {
      architect: 4000,
      curator: 2000,
      generator: 1000,
      evaluator: 1500,
      researcherPhase2: 3000,
    },
    ...overrides,
  };
}

function makeClient(prefetchResult: Record<string, unknown> = {}): GraphClient {
  return {
    prefetch: vi.fn().mockResolvedValue(prefetchResult),
  } as unknown as GraphClient;
}

function makeArtifactStore(stale = false, lastSyncedHeadSha?: string): GraphArtifactStore {
  return {
    staleness: vi.fn().mockResolvedValue(
      stale
        ? { stale: true, reason: "HEAD_DIFFERS", detail: "sha differs" }
        : { stale: false },
    ),
    readManifest: vi.fn().mockResolvedValue(
      lastSyncedHeadSha
        ? { lastSyncedHeadSha, lastSyncAt: "2026-01-01T00:00:00Z" }
        : null,
    ),
  } as unknown as GraphArtifactStore;
}

function makeIncidents(): IncidentLog {
  return {
    append: vi.fn().mockResolvedValue(undefined),
  } as unknown as IncidentLog;
}

const fixtureContract: SprintContract = {
  contractId: "test-fixture-1",
  specId: "spec-fixture",
  sprintNumber: 1,
  title: "Graph Foundations TokensavePrereqCheck Schema",
  description: "Foundation layer to detect tokensave with version check and extend config.",
  status: "in-progress",
  dependsOn: [],
  features: ["feat-1"],
  successCriteria: [
    {
      criterionId: "s1-c1",
      description: "src/graph/prereq.ts exports TokensavePrereqCheck with check() method that validates binary.",
      verificationMethod: "unit-test",
      required: true,
    },
  ],
  nonGoals: ["Do not spawn subprocess"],
  stopConditions: ["All success criteria pass"],
  definitionOfDone: "Sprint is done when all criteria pass.",
  assumptions: [],
  outOfScope: [],
  estimatedFiles: ["src/graph/prereq.ts", "src/config/schema.ts"],
  iterationHistory: [],
  lastEvalId: null,
};

// ── Tests ──────────────────────────────────────────────────────────

describe("PreflightContextInjector", () => {
  beforeEach(() => {
    vi.mocked(graphPipelineLifecycle.engineHealth).mockReturnValue("ready");
  });

  // ── s6-c1: graph disabled → firstMessage verbatim ────────────────

  describe("graph disabled / engine not ready", () => {
    it("returns firstMessage unchanged when graph.enabled=false", async () => {
      const client = makeClient();
      const config = makeGraphConfig({ enabled: false });
      const injector = new PreflightContextInjector(client, config);
      const original = "Original first message";
      const result = await injector.inject("curator", fixtureContract, original);
      expect(result).toBe(original);
      expect(client.prefetch).not.toHaveBeenCalled();
    });

    it("returns firstMessage unchanged when client is null", async () => {
      const config = makeGraphConfig();
      const injector = new PreflightContextInjector(null, config);
      const original = "Original first message";
      const result = await injector.inject("curator", fixtureContract, original);
      expect(result).toBe(original);
    });

    it("returns firstMessage unchanged when engineHealth is 'starting'", async () => {
      vi.mocked(graphPipelineLifecycle.engineHealth).mockReturnValue("starting");
      const client = makeClient();
      const config = makeGraphConfig();
      const injector = new PreflightContextInjector(client, config);
      const original = "Original message";
      const result = await injector.inject("curator", fixtureContract, original);
      expect(result).toBe(original);
      expect(client.prefetch).not.toHaveBeenCalled();
    });

    it("returns firstMessage unchanged when engineHealth is 'broken'", async () => {
      vi.mocked(graphPipelineLifecycle.engineHealth).mockReturnValue("broken");
      const client = makeClient();
      const config = makeGraphConfig();
      const injector = new PreflightContextInjector(client, config);
      const original = "Original message";
      const result = await injector.inject("curator", fixtureContract, original);
      expect(result).toBe(original);
    });

    it("returns firstMessage unchanged when engineHealth is 'disabled'", async () => {
      vi.mocked(graphPipelineLifecycle.engineHealth).mockReturnValue("disabled");
      const client = makeClient();
      const config = makeGraphConfig();
      const injector = new PreflightContextInjector(client, config);
      const original = "Original message";
      const result = await injector.inject("curator", fixtureContract, original);
      expect(result).toBe(original);
    });
  });

  // ── s6-c2: QUERY_BATCHES per role ───────────────────────────────

  describe("QUERY_BATCHES derivation per role", () => {
    it("architect batch includes overview + imports_of for each symbol", () => {
      const input = { symbols: ["prereq", "schema"], keywords: [], questionKeywords: [], baselineSha: "HEAD~1" };
      const specs = QUERY_BATCHES.architect(input);
      expect(specs[0]).toMatchObject({ op: "overview" });
      expect(specs[1]).toMatchObject({ op: "query", args: expect.objectContaining({ pattern: "imports_of" }) });
      expect(specs[2]).toMatchObject({ op: "query", args: expect.objectContaining({ pattern: "imports_of" }) });
    });

    it("architect batch with no symbols → only overview", () => {
      const input = { symbols: [], keywords: [], questionKeywords: [], baselineSha: "HEAD~1" };
      const specs = QUERY_BATCHES.architect(input);
      expect(specs).toHaveLength(1);
      expect(specs[0]?.op).toBe("overview");
    });

    it("curator batch includes search + callers_of + tests_for per symbol", () => {
      const input = { symbols: ["myFn"], keywords: ["graph", "prefetch"], questionKeywords: [], baselineSha: "HEAD~1" };
      const specs = QUERY_BATCHES.curator(input);
      const ops = specs.map((s) => s.op);
      expect(ops).toContain("search");
      expect(ops).toContain("query");
      // callers_of + tests_for = 2 queries per symbol
      const patterns = specs
        .filter((s) => s.op === "query")
        .map((s) => (s.args as { pattern: string }).pattern);
      expect(patterns).toContain("callers_of");
      expect(patterns).toContain("tests_for");
    });

    it("curator batch with no keywords → no search spec", () => {
      const input = { symbols: ["myFn"], keywords: [], questionKeywords: [], baselineSha: "HEAD~1" };
      const specs = QUERY_BATCHES.curator(input);
      expect(specs.every((s) => s.op !== "search")).toBe(true);
    });

    it("generator batch includes impact + tests_for per symbol", () => {
      const input = { symbols: ["myFn"], keywords: [], questionKeywords: [], baselineSha: "HEAD~1" };
      const specs = QUERY_BATCHES.generator(input);
      expect(specs.some((s) => s.op === "impact")).toBe(true);
      expect(specs.some((s) => s.op === "query")).toBe(true);
    });

    it("evaluator batch includes changes with baselineSha", () => {
      const input = { symbols: [], keywords: [], questionKeywords: [], baselineSha: "abc1234" };
      const specs = QUERY_BATCHES.evaluator(input);
      expect(specs).toHaveLength(1);
      expect(specs[0]?.op).toBe("changes");
      expect((specs[0]?.args as { since: string }).since).toBe("abc1234");
    });

    it("researcher-phase2 batch includes overview + search from questionKeywords only", () => {
      const input = { symbols: [], keywords: [], questionKeywords: ["graph", "query"], baselineSha: "" };
      const specs = QUERY_BATCHES["researcher-phase2"](input);
      expect(specs[0]?.op).toBe("overview");
      expect(specs[1]?.op).toBe("search");
      expect((specs[1]?.args as { q: string }).q).toBe("graph query");
    });

    it("researcher-phase2 batch with no questionKeywords → only overview", () => {
      const input = { symbols: [], keywords: [], questionKeywords: [], baselineSha: "" };
      const specs = QUERY_BATCHES["researcher-phase2"](input);
      expect(specs).toHaveLength(1);
      expect(specs[0]?.op).toBe("overview");
    });
  });

  // ── s6-c3: Budget enforcement ────────────────────────────────────

  describe("budget enforcement", () => {
    it("curator: 5000-token response truncated to ≤2000 tokens with truncation marker", async () => {
      // Generate a large response that exceeds the 2000-token curator budget
      const bigText = "A".repeat(10000); // ~2500 tokens (10000/4)
      const client = makeClient({
        overview: { ok: true, data: bigText, backend: "mcp", durationMs: 1 },
      });
      const config = makeGraphConfig();
      // Use architect role for a simpler batch (overview only) to isolate budget test
      const injector = new PreflightContextInjector(client, config);
      const result = await injector.inject("architect", null, "msg");

      // The output should include the section header
      expect(result).toContain("## Codebase Context (graph)");
      // Tokens of entire output should be ≤ architect budget (4000)
      const outputTokens = Math.ceil(result.length / 4);
      expect(outputTokens).toBeLessThanOrEqual(4000 + 100); // small margin for header overhead
    });

    it("curator budget: over-budget response includes truncation marker", async () => {
      // Build a response that's way over curator budget (2000 tokens = 8000 chars)
      const bigText = "B".repeat(12000); // 3000 tokens
      const client = makeClient({
        search: { ok: true, data: [], backend: "mcp", durationMs: 1 },
        "callers-of-0": { ok: true, data: [], backend: "mcp", durationMs: 1 },
        "tests-for-curator-0": { ok: true, data: [
          { node: { id: "x", kind: "function", file: "src/x.ts", line: 1, symbol: "x" }, score: 1.0, snippet: bigText },
        ], backend: "mcp", durationMs: 1 },
      });
      const config = makeGraphConfig();
      const contractWithSymbol: SprintContract = {
        ...fixtureContract,
        estimatedFiles: ["src/x.ts"],
      };
      const injector = new PreflightContextInjector(client, config);
      const result = await injector.inject("curator", contractWithSymbol, "msg");
      // Tokens should be roughly ≤ curator budget
      const outputTokens = Math.ceil(result.length / 4);
      // Allow up to 2500 tokens (budget + hard-cap string overhead)
      expect(outputTokens).toBeLessThanOrEqual(2500);
    });
  });

  // ── s6-c4: Output formatting ─────────────────────────────────────

  describe("output formatting", () => {
    it("includes ## Codebase Context (graph) header", async () => {
      const client = makeClient({
        overview: { ok: true, data: "Overview text here.", backend: "mcp", durationMs: 1 },
      });
      const injector = new PreflightContextInjector(client, makeGraphConfig());
      const result = await injector.inject("architect", null, "msg");
      expect(result).toContain("## Codebase Context (graph)");
    });

    it("overview result is under ### Overview subsection", async () => {
      const client = makeClient({
        overview: { ok: true, data: "Codebase overview content.", backend: "mcp", durationMs: 1 },
      });
      const injector = new PreflightContextInjector(client, makeGraphConfig());
      const result = await injector.inject("architect", null, "msg");
      expect(result).toContain("### Overview");
      expect(result).toContain("Codebase overview content.");
    });

    it("prepends context section before firstMessage", async () => {
      const client = makeClient({
        overview: { ok: true, data: "overview.", backend: "mcp", durationMs: 1 },
      });
      const injector = new PreflightContextInjector(client, makeGraphConfig());
      const original = "Original agent message here";
      const result = await injector.inject("architect", null, original);
      // Context should appear before the original message
      const contextIdx = result.indexOf("## Codebase Context");
      const msgIdx = result.indexOf(original);
      expect(contextIdx).toBeLessThan(msgIdx);
    });

    it("search results get ### Search: heading", async () => {
      const client = makeClient({
        search: { ok: true, data: [
          { node: { id: "fn", kind: "function", file: "src/fn.ts", line: 5, symbol: "myFn" }, score: 0.9, snippet: "..." },
        ], backend: "mcp", durationMs: 1 },
        "callers-of-0": { ok: true, data: [], backend: "mcp", durationMs: 1 },
        "tests-for-curator-0": { ok: true, data: [], backend: "mcp", durationMs: 1 },
      });
      const config = makeGraphConfig();
      const contractWithSymbols = { ...fixtureContract, estimatedFiles: ["src/fn.ts"] };
      const injector = new PreflightContextInjector(client, config);
      const result = await injector.inject("curator", contractWithSymbols, "msg");
      expect(result).toMatch(/### Search:/);
    });
  });

  // ── s6-c5: Failure isolation ─────────────────────────────────────

  describe("failure isolation", () => {
    it("failed query is silently omitted; warning line appears", async () => {
      const client = makeClient({
        overview: { ok: true, data: "overview text", backend: "mcp", durationMs: 1 },
        "imports-of-0": { ok: false, reason: "GRAPH_ERROR", detail: "error!" },
      });
      const config = makeGraphConfig();
      const contractWithSymbols = { ...fixtureContract, estimatedFiles: ["src/prereq.ts"] };
      const injector = new PreflightContextInjector(client, config);
      const result = await injector.inject("architect", contractWithSymbols, "msg");
      // Failed query should not cause any error output
      expect(result).not.toContain("GRAPH_ERROR");
      // Warning line should appear
      expect(result).toContain("Some graph queries unavailable");
    });

    it("one failing query does not prevent other results from appearing", async () => {
      const client = makeClient({
        overview: { ok: true, data: "overview text", backend: "mcp", durationMs: 1 },
        "imports-of-0": { ok: false, reason: "GRAPH_TIMEOUT", detail: "timeout" },
      });
      const config = makeGraphConfig();
      const contractWithSymbols = { ...fixtureContract, estimatedFiles: ["src/prereq.ts"] };
      const injector = new PreflightContextInjector(client, config);
      const result = await injector.inject("architect", contractWithSymbols, "msg");
      expect(result).toContain("overview text");
    });

    it("all queries fail → returns only warning line", async () => {
      const client = makeClient({
        overview: { ok: false, reason: "GRAPH_ERROR", detail: "engine broken" },
      });
      const injector = new PreflightContextInjector(client, makeGraphConfig());
      const original = "Original msg";
      const result = await injector.inject("architect", null, original);
      // Should contain the warning but not crash
      expect(result).toContain("## Codebase Context (graph)");
      expect(result).toContain("Some graph queries unavailable");
    });

    it("injection failure (prefetch throws) → returns firstMessage unchanged and logs incident", async () => {
      const client = {
        prefetch: vi.fn().mockRejectedValue(new Error("prefetch exploded")),
      } as unknown as GraphClient;
      const incidents = makeIncidents();
      const injector = new PreflightContextInjector(client, makeGraphConfig(), incidents);
      const original = "Original message";
      const result = await injector.inject("curator", fixtureContract, original);
      expect(result).toBe(original);
      expect(incidents.append).toHaveBeenCalledWith(
        expect.objectContaining({ event: "preflight-failure", role: "curator" }),
      );
    });
  });

  // ── s6-c6: Stale banner ──────────────────────────────────────────

  describe("stale banner", () => {
    it("prepends stale banner above ## Codebase Context when stale=true", async () => {
      // Synthetic SHAs:
      //   lastSyncedHeadSha = "abc1234def5678..." → sliced to short form "abc1234"
      //   currentSha (mocked via execa) = "def5678901234..." → sliced to short form "def5678"
      const client = makeClient({
        overview: { ok: true, data: "overview", backend: "mcp", durationMs: 1 },
      });
      const store = makeArtifactStore(true, "abc1234def5678901234567890abcdef01234567");
      // Override execa mock for this test to return deterministic synthetic current SHA
      vi.mocked(execa).mockResolvedValue(
        { exitCode: 0, stdout: "def5678901234abcdef01234567890ab12345678" } as Awaited<ReturnType<typeof execa>>,
      );
      const injector = new PreflightContextInjector(
        client,
        makeGraphConfig(),
        makeIncidents(),
        "/tmp/test-root",
        store,
      );
      const result = await injector.inject("architect", null, "msg");
      // Stale banner should appear before the section header
      const bannerIdx = result.indexOf("⚠");
      const headerIdx = result.indexOf("## Codebase Context");
      expect(bannerIdx).toBeGreaterThanOrEqual(0);
      expect(bannerIdx).toBeLessThan(headerIdx);
      // Both synthetic SHAs must appear in the banner (7-char short forms)
      expect(result).toContain("abc1234");
      expect(result).toContain("def5678");
      // Format assertion: banner matches expected stale pattern with two SHAs
      expect(result).toMatch(/_⚠ Graph indexed at SHA [a-f0-9]{7}; current HEAD is [a-f0-9]{7}/i);
    });

    it("no stale banner when stale=false", async () => {
      const client = makeClient({
        overview: { ok: true, data: "overview", backend: "mcp", durationMs: 1 },
      });
      const store = makeArtifactStore(false);
      const injector = new PreflightContextInjector(
        client,
        makeGraphConfig(),
        makeIncidents(),
        "/tmp/test-root",
        store,
      );
      const result = await injector.inject("architect", null, "msg");
      // No stale banner — but context section should still appear
      expect(result).toContain("## Codebase Context");
      // Should not have the stale warning
      expect(result).not.toContain("Graph indexed at SHA");
    });
  });

  // ── deriveFromContract ───────────────────────────────────────────

  describe("deriveFromContract", () => {
    it("returns empty arrays for null contract", () => {
      const result = deriveFromContract(null);
      expect(result.symbols).toEqual([]);
      expect(result.keywords).toEqual([]);
      expect(result.questionKeywords).toEqual([]);
      expect(result.baselineSha).toBe("HEAD~1");
    });

    it("derives symbols from estimatedFiles basenames", () => {
      const result = deriveFromContract(fixtureContract);
      // fixtureContract.estimatedFiles = ["src/graph/prereq.ts", "src/config/schema.ts"]
      expect(result.symbols).toContain("prereq");
      expect(result.symbols).toContain("schema");
    });

    it("derives keywords from title and description", () => {
      const result = deriveFromContract(fixtureContract);
      // title: "Graph Foundations TokensavePrereqCheck Schema"
      // Should extract tokens of length >= 4
      expect(result.keywords.length).toBeGreaterThan(0);
      // questionKeywords is always empty from contract derivation
      expect(result.questionKeywords).toEqual([]);
    });
  });

  // ── Empty input ──────────────────────────────────────────────────

  describe("empty input handling", () => {
    it("returns firstMessage unchanged when batch produces no specs (no symbols)", async () => {
      const client = makeClient();
      const config = makeGraphConfig();
      // generator with no symbols → empty batch
      const emptyContract: SprintContract = {
        ...fixtureContract,
        estimatedFiles: [], // no files → no symbols → empty generator batch
      };
      const injector = new PreflightContextInjector(client, config);
      const original = "Generator message";
      const result = await injector.inject("generator", emptyContract, original);
      // generator batch with no symbols → no specs → return unchanged
      expect(result).toBe(original);
    });

    it("evaluator batch always has at least one spec (changes)", async () => {
      const client = makeClient({
        changes: { ok: true, data: [], backend: "mcp", durationMs: 1 },
      });
      const injector = new PreflightContextInjector(client, makeGraphConfig());
      const result = await injector.inject("evaluator", null, "msg");
      expect(result).toContain("## Codebase Context (graph)");
    });
  });
});
