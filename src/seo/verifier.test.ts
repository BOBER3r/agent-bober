/**
 * Tests for `SeoRecommendationVerifier` (spec-20260715-ultimate-seo-suite,
 * Sprint 12, sc-12-1..sc-12-4). Every test injects `llm` (a `ScriptedClient`
 * or a throwing stub) — the default `createClient()` path is never taken,
 * so this file makes zero real provider calls.
 */
import { describe, it, expect } from "vitest";
import type { LLMClient, ChatParams, ChatResponse } from "../providers/types.js";
import { createDefaultConfig } from "../config/schema.js";
import type { BoberConfig } from "../config/schema.js";
import { SeoRecommendationVerifier } from "./verifier.js";
import type { SeoFinding } from "./types.js";

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

function enabledConfig(): BoberConfig {
  return createDefaultConfig("test-project", "brownfield", undefined, {
    seo: { verifier: { enabled: true }, blockThreshold: "critical-uncited" },
  });
}

function disabledConfig(): BoberConfig {
  // `seo` omitted entirely -> `config.seo?.verifier?.enabled` is undefined (default false).
  return createDefaultConfig("test-project", "brownfield");
}

function makeFinding(overrides: Partial<SeoFinding> = {}): SeoFinding {
  return {
    recommendation: "De-duplicate the title tag shared by /a and /b.",
    workflow: "technical-audit",
    playbookRef: "seo.technical-audit.title-tags",
    citationUrl: "https://developers.google.com/search/docs/appearance/title-link",
    evidence: [{ metric: "coverageState", value: "Indexed", source: "url-inspection", url: "https://example.com/a" }],
    severity: 3,
    humanApprovalRequired: false,
    confidence: "firm",
    ...overrides,
  };
}

const NOW = "2026-07-16T00:00:00.000Z";

// ── sc-12-2/sc-12-4: gate + no-op paths ─────────────────────────────────

describe("SeoRecommendationVerifier.verify — disabled/no-op paths (sc-12-2)", () => {
  it("empty findings -> ran:true, findings:[], zero LLM calls", async () => {
    const client = new ScriptedClient(["should never be used"]);
    const verifier = new SeoRecommendationVerifier();

    const result = await verifier.verify({
      findings: [],
      config: enabledConfig(),
      projectRoot: process.cwd(),
      now: NOW,
      llm: client,
    });

    expect(result).toEqual({ ran: true, findings: [] });
    expect(client.calls).toHaveLength(0);
  });

  it("config.seo.verifier.enabled !== true -> ran:false, findings unchanged, zero LLM calls", async () => {
    const client = new ScriptedClient(["should never be used"]);
    const verifier = new SeoRecommendationVerifier();
    const input = [makeFinding()];

    const result = await verifier.verify({
      findings: input,
      config: disabledConfig(),
      projectRoot: process.cwd(),
      now: NOW,
      llm: client,
    });

    expect(result.ran).toBe(false);
    expect(result.findings).toEqual(input);
    expect(result.findings).toBe(input); // same reference — no copy, no mutation
    expect(client.calls).toHaveLength(0);
  });
});

// ── sc-12-3: downgrade-only fold ────────────────────────────────────────

describe("SeoRecommendationVerifier.verify — downgrade-only fold (sc-12-3)", () => {
  it("'disproved' verdict drops the finding entirely", async () => {
    const finding = makeFinding({ severity: 4 });
    const client = new ScriptedClient([
      JSON.stringify({ verdicts: [{ index: 0, verdict: "disproved", confidence: "high", reason: "citationUrl does not back the claim" }] }),
    ]);
    const verifier = new SeoRecommendationVerifier();

    const result = await verifier.verify({
      findings: [finding],
      config: enabledConfig(),
      projectRoot: process.cwd(),
      now: NOW,
      llm: client,
    });

    expect(result.ran).toBe(true);
    expect(result.findings).toEqual([]);
    expect(client.calls).toHaveLength(1);
  });

  it("'downgraded' verdict lowers severity by exactly one, never raises", async () => {
    const finding = makeFinding({ severity: 3 });
    const client = new ScriptedClient([
      JSON.stringify({ verdicts: [{ index: 0, verdict: "downgraded", confidence: "medium", reason: "evidence supports a lesser issue" }] }),
    ]);
    const verifier = new SeoRecommendationVerifier();

    const result = await verifier.verify({
      findings: [finding],
      config: enabledConfig(),
      projectRoot: process.cwd(),
      now: NOW,
      llm: client,
    });

    expect(result.ran).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].severity).toBe(2);
    expect(result.findings[0]).toEqual({ ...finding, severity: 2 });
  });

  it("'downgraded' on a severity-1 finding is floored at 1, never below", async () => {
    const finding = makeFinding({ severity: 1 });
    const client = new ScriptedClient([
      JSON.stringify({ verdicts: [{ index: 0, verdict: "downgraded", confidence: "low", reason: "already minimal" }] }),
    ]);
    const verifier = new SeoRecommendationVerifier();

    const result = await verifier.verify({
      findings: [finding],
      config: enabledConfig(),
      projectRoot: process.cwd(),
      now: NOW,
      llm: client,
    });

    expect(result.findings[0].severity).toBe(1);
  });

  it("'confirmed' verdict keeps the finding byte-equal (unchanged)", async () => {
    const finding = makeFinding({ severity: 5 });
    const client = new ScriptedClient([
      JSON.stringify({ verdicts: [{ index: 0, verdict: "confirmed", confidence: "high", reason: "citation checks out" }] }),
    ]);
    const verifier = new SeoRecommendationVerifier();

    const result = await verifier.verify({
      findings: [finding],
      config: enabledConfig(),
      projectRoot: process.cwd(),
      now: NOW,
      llm: client,
    });

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toEqual(finding);
  });

  it("an unaddressed finding (no matching verdict entry) defaults to kept-unchanged, never silently dropped", async () => {
    const findings = [makeFinding({ recommendation: "A", severity: 3 }), makeFinding({ recommendation: "B", severity: 4 })];
    // Only index 0 addressed; index 1 has no verdict entry at all.
    const client = new ScriptedClient([
      JSON.stringify({ verdicts: [{ index: 0, verdict: "disproved", confidence: "high", reason: "bad citation" }] }),
    ]);
    const verifier = new SeoRecommendationVerifier();

    const result = await verifier.verify({
      findings,
      config: enabledConfig(),
      projectRoot: process.cwd(),
      now: NOW,
      llm: client,
    });

    expect(result.ran).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toEqual(findings[1]);
  });

  it("mixed verdicts across multiple findings: strict subset, severities only move down, never adds", async () => {
    const findings = [
      makeFinding({ recommendation: "confirmed-one", severity: 5 }),
      makeFinding({ recommendation: "downgraded-one", severity: 4 }),
      makeFinding({ recommendation: "disproved-one", severity: 3 }),
    ];
    const client = new ScriptedClient([
      JSON.stringify({
        verdicts: [
          { index: 0, verdict: "confirmed", confidence: "high", reason: "holds" },
          { index: 1, verdict: "downgraded", confidence: "medium", reason: "overstated" },
          { index: 2, verdict: "disproved", confidence: "high", reason: "invented citation" },
          // Extra out-of-range entry the model shouldn't be able to abuse to "add" a finding.
          { index: 99, verdict: "confirmed", confidence: "high", reason: "ignored — no such finding" },
        ],
      }),
    ]);
    const verifier = new SeoRecommendationVerifier();

    const result = await verifier.verify({
      findings,
      config: enabledConfig(),
      projectRoot: process.cwd(),
      now: NOW,
      llm: client,
    });

    expect(result.ran).toBe(true);
    // Strict subset — never adds (out-of-range index 99 has no effect).
    expect(result.findings.length).toBeLessThanOrEqual(findings.length);
    expect(result.findings).toHaveLength(2);
    // Every output severity is <= its corresponding input severity — never raises.
    const byRecommendation = new Map(findings.map((f) => [f.recommendation, f]));
    for (const out of result.findings) {
      const original = byRecommendation.get(out.recommendation)!;
      expect(out.severity).toBeLessThanOrEqual(original.severity);
    }
    expect(result.findings.find((f) => f.recommendation === "confirmed-one")?.severity).toBe(5);
    expect(result.findings.find((f) => f.recommendation === "downgraded-one")?.severity).toBe(3);
    expect(result.findings.find((f) => f.recommendation === "disproved-one")).toBeUndefined();
  });
});

// ── sc-12-3: fail-closed on unparseable/invalid output ──────────────────

describe("SeoRecommendationVerifier.verify — fail-closed on unparseable output (sc-12-3)", () => {
  it("garbage text -> ran:false, findings unchanged", async () => {
    const finding = makeFinding();
    const client = new ScriptedClient(["this is not json at all"]);
    const verifier = new SeoRecommendationVerifier();

    const result = await verifier.verify({
      findings: [finding],
      config: enabledConfig(),
      projectRoot: process.cwd(),
      now: NOW,
      llm: client,
    });

    expect(result).toEqual({ ran: false, findings: [finding] });
  });

  it("empty object (missing verdicts key) -> ran:false, findings unchanged", async () => {
    const finding = makeFinding();
    const client = new ScriptedClient(["{}"]);
    const verifier = new SeoRecommendationVerifier();

    const result = await verifier.verify({
      findings: [finding],
      config: enabledConfig(),
      projectRoot: process.cwd(),
      now: NOW,
      llm: client,
    });

    expect(result).toEqual({ ran: false, findings: [finding] });
  });

  it("out-of-shape verdict enum value -> ran:false, findings unchanged", async () => {
    const finding = makeFinding();
    const client = new ScriptedClient([
      JSON.stringify({ verdicts: [{ index: 0, verdict: "promoted", confidence: "high", reason: "invalid enum" }] }),
    ]);
    const verifier = new SeoRecommendationVerifier();

    const result = await verifier.verify({
      findings: [finding],
      config: enabledConfig(),
      projectRoot: process.cwd(),
      now: NOW,
      llm: client,
    });

    expect(result).toEqual({ ran: false, findings: [finding] });
  });

  it("bare JSON array (wrong container shape) -> ran:false, findings unchanged", async () => {
    const finding = makeFinding();
    const client = new ScriptedClient([
      JSON.stringify([{ index: 0, verdict: "confirmed", confidence: "high", reason: "wrong shape" }]),
    ]);
    const verifier = new SeoRecommendationVerifier();

    const result = await verifier.verify({
      findings: [finding],
      config: enabledConfig(),
      projectRoot: process.cwd(),
      now: NOW,
      llm: client,
    });

    expect(result).toEqual({ ran: false, findings: [finding] });
  });

  it("does not throw across a variety of garbage inputs", async () => {
    const finding = makeFinding();
    for (const garbage of ["", "not json", "[]", "null", '{"verdicts": "nope"}']) {
      const client = new ScriptedClient([garbage]);
      const verifier = new SeoRecommendationVerifier();
      await expect(
        verifier.verify({
          findings: [finding],
          config: enabledConfig(),
          projectRoot: process.cwd(),
          now: NOW,
          llm: client,
        }),
      ).resolves.toEqual({ ran: false, findings: [finding] });
    }
  });

  it("parses a fenced ```json code block", async () => {
    const finding = makeFinding({ severity: 4 });
    const fenced =
      "Here is the result:\n```json\n" +
      JSON.stringify({ verdicts: [{ index: 0, verdict: "downgraded", confidence: "high", reason: "fenced" }] }) +
      "\n```";
    const client = new ScriptedClient([fenced]);
    const verifier = new SeoRecommendationVerifier();

    const result = await verifier.verify({
      findings: [finding],
      config: enabledConfig(),
      projectRoot: process.cwd(),
      now: NOW,
      llm: client,
    });

    expect(result.ran).toBe(true);
    expect(result.findings[0].severity).toBe(3);
  });

  it("parses prose-wrapped JSON (first { ... last })", async () => {
    const finding = makeFinding({ severity: 4 });
    const raw = JSON.stringify({ verdicts: [{ index: 0, verdict: "confirmed", confidence: "high", reason: "prose" }] });
    const prose = `Sure, here you go: ${raw} Hope that helps!`;
    const client = new ScriptedClient([prose]);
    const verifier = new SeoRecommendationVerifier();

    const result = await verifier.verify({
      findings: [finding],
      config: enabledConfig(),
      projectRoot: process.cwd(),
      now: NOW,
      llm: client,
    });

    expect(result.ran).toBe(true);
    expect(result.findings[0]).toEqual(finding);
  });
});

// ── sc-12-3/sc-12-4: provider error -> ran:false, NEVER rejects ─────────

describe("SeoRecommendationVerifier.verify — provider error (never throws)", () => {
  it("a throwing LLMClient resolves ran:false with findings unchanged, does NOT reject", async () => {
    const finding = makeFinding();
    const throwingClient: LLMClient = {
      async chat(_params: ChatParams): Promise<ChatResponse> {
        throw new Error("Network timeout");
      },
    };
    const verifier = new SeoRecommendationVerifier();

    await expect(
      verifier.verify({
        findings: [finding],
        config: enabledConfig(),
        projectRoot: process.cwd(),
        now: NOW,
        llm: throwingClient,
      }),
    ).resolves.toEqual({ ran: false, findings: [finding] });
  });
});

// ── sc-12-1: the agent md is load-bearing (wired, not drift) ────────────

describe("SeoRecommendationVerifier.verify — agent md is wired (sc-12-1)", () => {
  it("sends a system prompt containing downgrade-only / disprove language from agents/bober-seo-verifier.md", async () => {
    const finding = makeFinding();
    const client = new ScriptedClient([
      JSON.stringify({ verdicts: [{ index: 0, verdict: "confirmed", confidence: "high", reason: "ok" }] }),
    ]);
    const verifier = new SeoRecommendationVerifier();

    await verifier.verify({
      findings: [finding],
      config: enabledConfig(),
      projectRoot: process.cwd(),
      now: NOW,
      llm: client,
    });

    expect(client.calls).toHaveLength(1);
    const system = client.calls[0].system.toLowerCase();
    expect(system).toContain("disprove");
    expect(system).toContain("downgrad");
    expect(system).toContain("confirmed");
    expect(system).toContain("disproved");
  });

  it("calls the LLM with jsonObjectMode:true and includes the findings + injected now in the user message", async () => {
    const finding = makeFinding();
    const client = new ScriptedClient([
      JSON.stringify({ verdicts: [{ index: 0, verdict: "confirmed", confidence: "high", reason: "ok" }] }),
    ]);
    const verifier = new SeoRecommendationVerifier();

    await verifier.verify({
      findings: [finding],
      config: enabledConfig(),
      projectRoot: process.cwd(),
      now: "1999-12-31T23:59:59Z",
      llm: client,
    });

    const call = client.calls[0];
    expect(call.jsonObjectMode).toBe(true);
    expect(call.messages).toHaveLength(1);
    const userContent = (call.messages[0] as { content: string }).content;
    expect(userContent).toContain(finding.citationUrl);
    expect(userContent).toContain("1999-12-31T23:59:59Z");
  });
});
