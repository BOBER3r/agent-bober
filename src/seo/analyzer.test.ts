import { describe, it, expect } from "vitest";
import type { LLMClient, ChatParams, ChatResponse } from "../providers/types.js";
import type { BoberConfig } from "../config/schema.js";
import type { SeoRetrieveResult } from "./retriever.js";
import type { SeoSignature } from "./types.js";
import { SeoAnalyzer, type SeoAnalyzeInput, type SeoDataBundle } from "./analyzer.js";

// ── ScriptedClient (mirrors src/medical/retrieval/grounding-critic.test.ts:15-25) ──

/** Returns scripted responses in order; repeats the last once exhausted. Records every ChatParams. NO network. */
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

// `liveWeightStatus` is set to a NON-downgrading value ("live-corroborated")
// on both base fixtures so the existing confidence:"firm" assertions below
// (e.g. line ~117) are unaffected. The downgrade-only tests (sc-3-3) clone
// these via `{ ...SAMPLE_SIGNATURE, liveWeightStatus: "documented-only" }`.
const SAMPLE_SIGNATURE: SeoSignature = {
  playbookId: "seo.technical-audit.title-tags",
  workflows: ["technical-audit"],
  title: "Unique, descriptive title tags",
  tactic: "Ensure every indexable page has a unique <title>.",
  invariant: "No two indexable pages share an identical title tag.",
  primarySourceUrl: "https://developers.google.com/search/docs/appearance/title-link",
  policyClass: "auto-safe",
  evidenceGrade: "verified",
  liveWeightStatus: "live-corroborated",
  keywords: ["title", "duplicate"],
  skillRef: "bober.seo-technical-audit",
};

const SAMPLE_HUMAN_APPROVE_SIGNATURE: SeoSignature = {
  playbookId: "seo.technical-audit.paid-links",
  workflows: ["technical-audit"],
  title: "Paid link disclosure",
  tactic: "Any paid placement must use rel=sponsored.",
  invariant: "Paid links are always tagged rel=sponsored.",
  primarySourceUrl: "https://developers.google.com/search/docs/essentials/spam-policies",
  policyClass: "human-approve",
  evidenceGrade: "verified",
  liveWeightStatus: "live-corroborated",
  keywords: ["paid", "sponsored"],
  skillRef: "bober.seo-technical-audit",
};

const SAMPLE_CONTEXT: SeoRetrieveResult = {
  promptFragment: "### seo.technical-audit.title-tags — Unique, descriptive title tags\nInvariant: ...",
  signatures: [SAMPLE_SIGNATURE, SAMPLE_HUMAN_APPROVE_SIGNATURE],
};

const SAMPLE_DATA: SeoDataBundle = {
  urlInspection: {
    kind: "data",
    rows: [{ url: "https://example.com/a", coverageState: "Indexed" }],
    provenance: { source: "local-export", retrievedAt: "2026-07-16T00:00:00Z" },
  },
  serp: { kind: "abstain", reason: "no keyword export provided" },
  keywords: { kind: "disabled" },
};

function baseInput(overrides: Partial<SeoAnalyzeInput> = {}): SeoAnalyzeInput {
  return {
    workflow: "technical-audit",
    target: "example.com",
    context: SAMPLE_CONTEXT,
    data: SAMPLE_DATA,
    config: {} as BoberConfig,
    now: "2026-07-16T00:00:00Z",
    ...overrides,
  };
}

const VALID_FINDINGS_JSON = JSON.stringify({
  findings: [
    {
      recommendation: "De-duplicate the title tag shared by /a and /b.",
      playbookRef: "seo.technical-audit.title-tags",
      citationUrl: "https://developers.google.com/search/docs/appearance/title-link",
      evidence: [
        { metric: "coverageState", value: "Indexed", source: "url-inspection", url: "https://example.com/a" },
      ],
      severity: 3,
      humanApprovalRequired: false,
      confidence: "firm",
    },
  ],
});

// ── sc-10-1: well-formed findings JSON -> typed SeoFinding[] ──────────

describe("SeoAnalyzer.analyze — well-formed model output (sc-10-1)", () => {
  it("returns parsed:true with typed SeoFinding[] carrying citationUrl/severity/playbookRef/humanApprovalRequired", async () => {
    const client = new ScriptedClient([VALID_FINDINGS_JSON]);
    const analyzer = new SeoAnalyzer(client, "test-model");

    const analysis = await analyzer.analyze(baseInput());

    expect(analysis.parsed).toBe(true);
    expect(analysis.workflow).toBe("technical-audit");
    expect(analysis.target).toBe("example.com");
    expect(analysis.findings).toHaveLength(1);

    const finding = analysis.findings[0];
    expect(finding.citationUrl).toBe("https://developers.google.com/search/docs/appearance/title-link");
    expect(finding.citationUrl.length).toBeGreaterThan(0);
    expect(finding.severity).toBe(3);
    expect(finding.severity).toBeGreaterThanOrEqual(1);
    expect(finding.severity).toBeLessThanOrEqual(5);
    expect(finding.playbookRef).toBe("seo.technical-audit.title-tags");
    expect(typeof finding.humanApprovalRequired).toBe("boolean");
    expect(finding.workflow).toBe("technical-audit");
    expect(finding.confidence).toBe("firm");
  });

  it("calls the LLM with jsonObjectMode:true and includes the playbook context + data bundle in the system prompt", async () => {
    const client = new ScriptedClient([VALID_FINDINGS_JSON]);
    const analyzer = new SeoAnalyzer(client, "test-model");

    await analyzer.analyze(baseInput());

    expect(client.calls).toHaveLength(1);
    const call = client.calls[0];
    expect(call.model).toBe("test-model");
    expect(call.jsonObjectMode).toBe(true);
    expect(call.system).toContain(SAMPLE_CONTEXT.promptFragment);
    expect(call.system).toContain("example.com");
    expect(call.system).toContain("Indexed");
  });

  it("applies defense-in-depth: sets humanApprovalRequired true when the matched signature is policyClass human-approve, even if the model said false", async () => {
    const findingsJson = JSON.stringify({
      findings: [
        {
          recommendation: "Tag the paid placement with rel=sponsored.",
          playbookRef: "seo.technical-audit.paid-links",
          citationUrl: "https://developers.google.com/search/docs/essentials/spam-policies",
          evidence: [],
          severity: 4,
          humanApprovalRequired: false,
          confidence: "tentative",
        },
      ],
    });
    const client = new ScriptedClient([findingsJson]);
    const analyzer = new SeoAnalyzer(client, "test-model");

    const analysis = await analyzer.analyze(baseInput());

    expect(analysis.findings[0].humanApprovalRequired).toBe(true);
  });

  it("collects dataProvenance only from kind:'data' arms of the data bundle", async () => {
    const client = new ScriptedClient([VALID_FINDINGS_JSON]);
    const analyzer = new SeoAnalyzer(client, "test-model");

    const analysis = await analyzer.analyze(baseInput());

    expect(analysis.dataProvenance).toHaveLength(1);
    expect(analysis.dataProvenance[0]).toEqual({ source: "local-export", retrievedAt: "2026-07-16T00:00:00Z" });
  });
});

// ── sc-3-3 (spec-20260717-seo-improver-builder): liveWeightStatus drives a
// downgrade-only confidence rule -- documented-only + firm -> tentative;
// live-corroborated/unknown leave confidence unchanged; never upgrades ────

describe("SeoAnalyzer.analyze — liveWeightStatus downgrade-only confidence rule (sc-3-3)", () => {
  it("downgrades a firm finding to tentative when grounded in a documented-only signature", async () => {
    const documentedOnlySignature: SeoSignature = { ...SAMPLE_SIGNATURE, liveWeightStatus: "documented-only" };
    const context: SeoRetrieveResult = {
      promptFragment: SAMPLE_CONTEXT.promptFragment,
      signatures: [documentedOnlySignature],
    };
    const client = new ScriptedClient([VALID_FINDINGS_JSON]); // confidence: "firm"
    const analyzer = new SeoAnalyzer(client, "test-model");

    const analysis = await analyzer.analyze(baseInput({ context }));

    expect(analysis.findings).toHaveLength(1);
    expect(analysis.findings[0].confidence).toBe("tentative");
  });

  it("leaves confidence unchanged (firm) when grounded in a live-corroborated signature", async () => {
    const liveCorroboratedSignature: SeoSignature = { ...SAMPLE_SIGNATURE, liveWeightStatus: "live-corroborated" };
    const context: SeoRetrieveResult = {
      promptFragment: SAMPLE_CONTEXT.promptFragment,
      signatures: [liveCorroboratedSignature],
    };
    const client = new ScriptedClient([VALID_FINDINGS_JSON]); // confidence: "firm"
    const analyzer = new SeoAnalyzer(client, "test-model");

    const analysis = await analyzer.analyze(baseInput({ context }));

    expect(analysis.findings[0].confidence).toBe("firm");
  });

  it("leaves confidence unchanged (firm) when grounded in an unknown-liveWeightStatus signature", async () => {
    const unknownSignature: SeoSignature = { ...SAMPLE_SIGNATURE, liveWeightStatus: "unknown" };
    const context: SeoRetrieveResult = {
      promptFragment: SAMPLE_CONTEXT.promptFragment,
      signatures: [unknownSignature],
    };
    const client = new ScriptedClient([VALID_FINDINGS_JSON]); // confidence: "firm"
    const analyzer = new SeoAnalyzer(client, "test-model");

    const analysis = await analyzer.analyze(baseInput({ context }));

    expect(analysis.findings[0].confidence).toBe("firm");
  });

  it("never upgrades: a tentative finding grounded in documented-only stays tentative", async () => {
    const documentedOnlySignature: SeoSignature = { ...SAMPLE_SIGNATURE, liveWeightStatus: "documented-only" };
    const context: SeoRetrieveResult = {
      promptFragment: SAMPLE_CONTEXT.promptFragment,
      signatures: [documentedOnlySignature],
    };
    const tentativeFindingJson = JSON.stringify({
      findings: [
        {
          recommendation: "De-duplicate the title tag shared by /a and /b.",
          playbookRef: "seo.technical-audit.title-tags",
          citationUrl: "https://developers.google.com/search/docs/appearance/title-link",
          evidence: [],
          severity: 3,
          humanApprovalRequired: false,
          confidence: "tentative",
        },
      ],
    });
    const client = new ScriptedClient([tentativeFindingJson]);
    const analyzer = new SeoAnalyzer(client, "test-model");

    const analysis = await analyzer.analyze(baseInput({ context }));

    expect(analysis.findings[0].confidence).toBe("tentative");
  });

  it("leaves confidence unchanged when no matching signature is found for the playbookRef", async () => {
    const emptyContext: SeoRetrieveResult = { promptFragment: SAMPLE_CONTEXT.promptFragment, signatures: [] };
    const client = new ScriptedClient([VALID_FINDINGS_JSON]); // confidence: "firm"
    const analyzer = new SeoAnalyzer(client, "test-model");

    const analysis = await analyzer.analyze(baseInput({ context: emptyContext }));

    expect(analysis.findings[0].confidence).toBe("firm");
  });
});

// ── sc-10-2: unparseable output -> parsed:false, never throws ─────────

describe("SeoAnalyzer.analyze — unparseable model output (sc-10-2, stopCondition)", () => {
  it("returns { findings: [], parsed: false } for garbage text and does not throw", async () => {
    const client = new ScriptedClient(["this is not json at all"]);
    const analyzer = new SeoAnalyzer(client, "test-model");

    await expect(analyzer.analyze(baseInput())).resolves.toEqual(
      expect.objectContaining({ findings: [], parsed: false }),
    );
  });

  it("returns parsed:false for an empty container (missing findings array)", async () => {
    const client = new ScriptedClient(["{}"]);
    const analyzer = new SeoAnalyzer(client, "test-model");

    const analysis = await analyzer.analyze(baseInput());
    expect(analysis.parsed).toBe(false);
    expect(analysis.findings).toEqual([]);
  });

  it("returns parsed:false when a finding has an out-of-range severity", async () => {
    const badSeverityJson = JSON.stringify({
      findings: [
        {
          recommendation: "x",
          playbookRef: "seo.technical-audit.title-tags",
          citationUrl: "https://example.com",
          evidence: [],
          severity: 7,
          humanApprovalRequired: false,
          confidence: "firm",
        },
      ],
    });
    const client = new ScriptedClient([badSeverityJson]);
    const analyzer = new SeoAnalyzer(client, "test-model");

    const analysis = await analyzer.analyze(baseInput());
    expect(analysis.parsed).toBe(false);
    expect(analysis.findings).toEqual([]);
  });

  it("still populates dataProvenance even when the LLM output is unparseable", async () => {
    const client = new ScriptedClient(["garbage"]);
    const analyzer = new SeoAnalyzer(client, "test-model");

    const analysis = await analyzer.analyze(baseInput());
    expect(analysis.dataProvenance).toHaveLength(1);
  });

  it("parses a fenced ```json code block", async () => {
    const fenced = "Here is the result:\n```json\n" + VALID_FINDINGS_JSON + "\n```";
    const client = new ScriptedClient([fenced]);
    const analyzer = new SeoAnalyzer(client, "test-model");

    const analysis = await analyzer.analyze(baseInput());
    expect(analysis.parsed).toBe(true);
    expect(analysis.findings).toHaveLength(1);
  });

  it("parses prose-wrapped JSON (first { ... last })", async () => {
    const prose = `Sure, here you go: ${VALID_FINDINGS_JSON} Hope that helps!`;
    const client = new ScriptedClient([prose]);
    const analyzer = new SeoAnalyzer(client, "test-model");

    const analysis = await analyzer.analyze(baseInput());
    expect(analysis.parsed).toBe(true);
    expect(analysis.findings).toHaveLength(1);
  });

  it("does not throw for a throwing (misbehaving) parse path across a variety of garbage inputs", async () => {
    for (const garbage of ["", "not json", "[]", "null", "{\"findings\": \"nope\"}"]) {
      const client = new ScriptedClient([garbage]);
      const analyzer = new SeoAnalyzer(client, "test-model");
      await expect(analyzer.analyze(baseInput())).resolves.toEqual(
        expect.objectContaining({ parsed: false, findings: [] }),
      );
    }
  });
});

// ── Transport errors propagate (distinct from parse failures) ─────────

describe("SeoAnalyzer.analyze — transport error propagation", () => {
  it("propagates an LLM transport error rather than swallowing it into parsed:false", async () => {
    const throwingClient: LLMClient = {
      async chat(_params: ChatParams): Promise<ChatResponse> {
        throw new Error("Network timeout");
      },
    };
    const analyzer = new SeoAnalyzer(throwingClient, "test-model");

    await expect(analyzer.analyze(baseInput())).rejects.toThrow("Network timeout");
  });
});

// ── Clock purity: no wall-clock reads, only the injected `now` ────────

describe("SeoAnalyzer.analyze — clock purity", () => {
  it("is deterministic across repeated calls with a fixed injected `now` (no hidden wall-clock dependency)", async () => {
    const client1 = new ScriptedClient([VALID_FINDINGS_JSON]);
    const client2 = new ScriptedClient([VALID_FINDINGS_JSON]);
    const analyzer1 = new SeoAnalyzer(client1, "test-model");
    const analyzer2 = new SeoAnalyzer(client2, "test-model");

    const input = baseInput({ now: "2020-01-01T00:00:00Z" });
    const [a, b] = await Promise.all([analyzer1.analyze(input), analyzer2.analyze(input)]);

    expect(a).toEqual(b);
  });

  it("threads the injected `now` into the system prompt rather than reading the clock", async () => {
    const client = new ScriptedClient([VALID_FINDINGS_JSON]);
    const analyzer = new SeoAnalyzer(client, "test-model");

    await analyzer.analyze(baseInput({ now: "1999-12-31T23:59:59Z" }));

    expect(client.calls[0].system).toContain("1999-12-31T23:59:59Z");
  });
});
