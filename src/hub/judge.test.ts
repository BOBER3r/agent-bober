import { describe, it, expect } from "vitest";
import type { LLMClient, ChatParams, ChatResponse } from "../providers/types.js";
import type { Finding } from "./finding.js";
import { rankFindings } from "./judge.js";
import { parseScope } from "./scope.js";

// ── ScriptedClient ────────────────────────────────────────────────────

/** Returns scripted responses in call order; repeats the last once exhausted. Records every ChatParams. */
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

// ── Fixtures ──────────────────────────────────────────────────────────

const T = "2026-06-28T00:00:00.000Z";

function makeFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "f-001",
    domain: "medical",
    title: "Test finding",
    kind: "action",
    urgency: 3,
    severity: 3,
    evidence: ["evidence"],
    surfacedAt: T,
    tags: [],
    status: "open",
    ...over,
  };
}

const NOW = new Date("2026-06-28T00:00:00.000Z");

// ── Shared response strings ───────────────────────────────────────────

const RELEVANT = '{"relevant":true}';
const IRRELEVANT = '{"relevant":false}';
const GARBAGE = "not valid json at all !!";
const INCLUDE_HIGH = '{"include":true,"score":9}';
const INCLUDE_MED = '{"include":true,"score":5}';
const INCLUDE_LOW = '{"include":true,"score":2}';
const EXCLUDE = '{"include":false,"score":1}';

// ── sc-3-2: deterministic ranking + tie-break chain ───────────────────

describe("sc-3-2: deterministic ranking", () => {
  it("ranks by aggregate lens score DESC and produces identical output across two runs", async () => {
    const f1 = makeFinding({ id: "f-1", urgency: 5, severity: 5, dueBy: "2026-07-01T00:00:00.000Z" });
    const f2 = makeFinding({ id: "f-2", urgency: 3, severity: 3 });
    const f3 = makeFinding({ id: "f-3", urgency: 1, severity: 1 });
    const findings = [f1, f2, f3];
    const scope = parseScope({ mode: "general" });

    // 3 relevance calls + 3 × 4 lens calls = 15 calls per run
    function makeResponses(): string[] {
      return [
        RELEVANT, RELEVANT, RELEVANT,                                          // pass-1
        INCLUDE_HIGH, INCLUDE_HIGH, INCLUDE_HIGH, INCLUDE_HIGH,               // f1 lenses → agg=36
        INCLUDE_MED, INCLUDE_MED, INCLUDE_MED, INCLUDE_MED,                   // f2 lenses → agg=20
        INCLUDE_LOW, INCLUDE_LOW, INCLUDE_LOW, INCLUDE_LOW,                   // f3 lenses → agg=8
      ];
    }

    // Run twice with separate clients (same response script)
    const result1 = await rankFindings(findings, scope, new ScriptedClient(makeResponses()), NOW);
    const result2 = await rankFindings(findings, scope, new ScriptedClient(makeResponses()), NOW);

    // Correct order: f1 (agg=36) > f2 (agg=20) > f3 (agg=8)
    expect(result1.map((f) => f.id)).toEqual(["f-1", "f-2", "f-3"]);

    // Identical across repeated runs (determinism guarantee)
    expect(result1.map((f) => f.id)).toEqual(result2.map((f) => f.id));
  });

  it("tie-breaks by urgency DESC, then severity DESC, then dueBy ASC (undefined LAST), then id ASC", async () => {
    // All findings will share the same aggregate score (5×4=20) to exercise tie-breaking
    const tieA = makeFinding({ id: "f-tie-a", urgency: 5, severity: 5, dueBy: "2026-07-01T00:00:00.000Z" });
    const tieB = makeFinding({ id: "f-tie-b", urgency: 5, severity: 5, dueBy: "2026-07-02T00:00:00.000Z" });
    const tieC = makeFinding({ id: "f-tie-c", urgency: 5, severity: 5 }); // dueBy=undefined → LAST in group
    const tieD = makeFinding({ id: "f-tie-d", urgency: 5, severity: 4, dueBy: "2026-07-01T00:00:00.000Z" });
    const tieE = makeFinding({ id: "f-tie-e", urgency: 4, severity: 5, dueBy: "2026-07-01T00:00:00.000Z" });
    const idZ  = makeFinding({ id: "id-z", urgency: 3, severity: 3 }); // same as idA except id
    const idA  = makeFinding({ id: "id-a", urgency: 3, severity: 3 }); // id-a < id-z → comes first
    const findings = [tieA, tieB, tieC, tieD, tieE, idZ, idA];
    const scope = parseScope({ mode: "general" });

    const MED = '{"include":true,"score":5}';
    // 7 relevance calls + 7 × 4 = 28 lens calls = 35 calls total; all lens scores=5
    const responses = [...Array(7).fill(RELEVANT), ...Array(28).fill(MED)];

    const result = await rankFindings(findings, scope, new ScriptedClient(responses), NOW);
    const ids = result.map((f) => f.id);

    // 1. aggregate=20 for all → tie on score
    // 2. urgency DESC: tieA/B/C/D (urg=5) before tieE (urg=4) before idZ/idA (urg=3)
    // 3. severity DESC (within urg=5): tieA/B/C (sev=5) before tieD (sev=4)
    // 4. dueBy ASC undefined-last (within urg=5 sev=5): tieA(Jul01) < tieB(Jul02) < tieC(undefined=LAST)
    // 5. id ASC (within urg=3 sev=3 no dueBy): id-a < id-z
    expect(ids[0]).toBe("f-tie-a");
    expect(ids[1]).toBe("f-tie-b");
    expect(ids[2]).toBe("f-tie-c"); // undefined dueBy is LAST within same urgency/severity group
    expect(ids[3]).toBe("f-tie-d"); // severity=4 < 5
    expect(ids[4]).toBe("f-tie-e"); // urgency=4 < 5
    expect(ids[5]).toBe("id-a");    // id-a < id-z lexicographically
    expect(ids[6]).toBe("id-z");
  });
});

// ── sc-3-3: flagged-for-review on tie ─────────────────────────────────

describe("sc-3-3: tie → finding kept with flagged-for-review tag, NOT dropped", () => {
  it("returns the finding tagged flagged-for-review on a 2-2 lens vote tie", async () => {
    const finding = makeFinding({ id: "f-tie-vote", urgency: 3, severity: 3 });
    const scope = parseScope({ mode: "general" });

    // 1 relevance call + 4 lens calls = 5 calls
    // lenses: 2 include + 2 exclude = 2-2 tie → fail-closed → flagged-for-review
    const responses = [
      RELEVANT,
      '{"include":true,"score":7}',   // urgency: include
      '{"include":true,"score":7}',   // impact: include
      '{"include":false,"score":3}',  // effort: exclude
      '{"include":false,"score":3}',  // deadline-risk: exclude
    ];

    const result = await rankFindings([finding], scope, new ScriptedClient(responses), NOW);

    expect(result).toHaveLength(1); // NOT dropped
    expect(result[0]?.id).toBe("f-tie-vote");
    expect(result[0]?.tags).toContain("flagged-for-review");
  });

  it("returns the finding tagged flagged-for-review when all 4 lenses exclude (0-4 failVotes)", async () => {
    const finding = makeFinding({ id: "f-all-fail", urgency: 2, severity: 2 });
    const scope = parseScope({ mode: "general" });

    const responses = [RELEVANT, EXCLUDE, EXCLUDE, EXCLUDE, EXCLUDE];

    const result = await rankFindings([finding], scope, new ScriptedClient(responses), NOW);

    expect(result).toHaveLength(1); // NOT dropped
    expect(result[0]?.tags).toContain("flagged-for-review");
  });

  it("returns the finding tagged flagged-for-review on 1-3 minority include vote", async () => {
    const finding = makeFinding({ id: "f-minority" });
    const scope = parseScope({ mode: "general" });

    const responses = [
      RELEVANT,
      '{"include":true,"score":6}',   // urgency: include (1 vote)
      '{"include":false,"score":2}',  // impact: exclude
      '{"include":false,"score":2}',  // effort: exclude
      '{"include":false,"score":2}',  // deadline-risk: exclude
    ];

    const result = await rankFindings([finding], scope, new ScriptedClient(responses), NOW);

    expect(result).toHaveLength(1);
    expect(result[0]?.tags).toContain("flagged-for-review");
  });

  it("does NOT mutate the original finding's tags array", async () => {
    const originalTags = ["existing-tag"];
    const finding = makeFinding({ id: "f-nomutate", tags: originalTags });
    const scope = parseScope({ mode: "general" });

    const responses = [RELEVANT, EXCLUDE, EXCLUDE, EXCLUDE, EXCLUDE];

    await rankFindings([finding], scope, new ScriptedClient(responses), NOW);

    // Original finding must be byte-identical; tags must not include flagged-for-review
    expect(finding.tags).toEqual(["existing-tag"]);
    expect(finding.tags).not.toContain("flagged-for-review");
  });

  it("does NOT tag with flagged-for-review when a strict majority (3-1) includes", async () => {
    const finding = makeFinding({ id: "f-majority" });
    const scope = parseScope({ mode: "general" });

    const responses = [
      RELEVANT,
      '{"include":true,"score":8}',   // include
      '{"include":true,"score":8}',   // include
      '{"include":true,"score":8}',   // include
      '{"include":false,"score":2}',  // exclude (1 fail vote)
    ];

    const result = await rankFindings([finding], scope, new ScriptedClient(responses), NOW);

    expect(result).toHaveLength(1);
    expect(result[0]?.tags).not.toContain("flagged-for-review");
  });
});

// ── sc-3-4: decision scope filtering ──────────────────────────────────

describe("sc-3-4: decision scope — optionA/optionB survive, neither dropped in pass 1", () => {
  it("keeps findings for optionA and optionB, drops finding marked neither", async () => {
    const fA      = makeFinding({ id: "f-optA", urgency: 5, severity: 5 });
    const fB      = makeFinding({ id: "f-optB", urgency: 3, severity: 3 });
    const fNeither = makeFinding({ id: "f-neither", urgency: 4, severity: 4 });
    const findings = [fA, fB, fNeither];
    const scope = parseScope({ mode: "decision", optionA: "buy a house", optionB: "rent an apartment" });

    // Pass-1: 3 relevance calls
    // fA → optionA, fB → optionB, fNeither → neither (DROPPED in pass-1)
    // Pass-2: only 2 survivors × 4 lenses = 8 calls
    const responses = [
      '{"relevant":true,"relevantTo":"optionA"}',    // fA
      '{"relevant":true,"relevantTo":"optionB"}',    // fB
      '{"relevant":true,"relevantTo":"neither"}',    // fNeither → dropped
      // fA lenses (high scores)
      INCLUDE_HIGH, INCLUDE_HIGH, INCLUDE_HIGH, INCLUDE_HIGH,
      // fB lenses (medium scores)
      INCLUDE_MED, INCLUDE_MED, INCLUDE_MED, INCLUDE_MED,
    ];

    const result = await rankFindings(findings, scope, new ScriptedClient(responses), NOW);

    // Only fA and fB survive
    expect(result.map((f) => f.id)).toEqual(["f-optA", "f-optB"]);
    expect(result.find((f) => f.id === "f-neither")).toBeUndefined();
  });

  it("keeps a finding marked 'both' (relevant to both options)", async () => {
    const fBoth = makeFinding({ id: "f-both", urgency: 5, severity: 5 });
    const scope = parseScope({ mode: "decision", optionA: "Option A", optionB: "Option B" });

    const responses = [
      '{"relevant":true,"relevantTo":"both"}',
      INCLUDE_HIGH, INCLUDE_HIGH, INCLUDE_HIGH, INCLUDE_HIGH,
    ];

    const result = await rankFindings([fBoth], scope, new ScriptedClient(responses), NOW);

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("f-both");
  });

  it("drops a finding when relevantTo is undefined (fail-closed for decision scope)", async () => {
    const fNoFrame = makeFinding({ id: "f-no-frame" });
    const scope = parseScope({ mode: "decision", optionA: "A", optionB: "B" });

    // relevant=true but no relevantTo field → undefined → dropped
    const responses = ['{"relevant":true}'];

    const result = await rankFindings([fNoFrame], scope, new ScriptedClient(responses), NOW);

    expect(result).toHaveLength(0);
  });

  it("drops a finding when LLM verdict is unparseable (null → fail-closed, no pass-2)", async () => {
    const fGarbage = makeFinding({ id: "f-garbage" });
    const scope = parseScope({ mode: "decision", optionA: "A", optionB: "B" });

    const responses = [GARBAGE]; // unparseable → null verdict → drop

    const result = await rankFindings([fGarbage], scope, new ScriptedClient(responses), NOW);

    expect(result).toHaveLength(0);
  });

  it("drops a finding when relevant=false in decision scope", async () => {
    const fIrrelevant = makeFinding({ id: "f-irrelevant" });
    const scope = parseScope({ mode: "decision", optionA: "A", optionB: "B" });

    const responses = [IRRELEVANT];

    const result = await rankFindings([fIrrelevant], scope, new ScriptedClient(responses), NOW);

    expect(result).toHaveLength(0);
  });
});

// ── sc-3-5: injected client, no real network ──────────────────────────

describe("sc-3-5: judge uses injected LLMClient with no real network", () => {
  it("records exactly N passes through the injected client (1 relevance + 4 lens = 5 calls for 1 finding)", async () => {
    const finding = makeFinding({ id: "f-inject" });
    const scope = parseScope({ mode: "general" });

    const responses = [RELEVANT, INCLUDE_HIGH, INCLUDE_HIGH, INCLUDE_HIGH, INCLUDE_HIGH];
    const client = new ScriptedClient(responses);

    await rankFindings([finding], scope, client, NOW);

    // 1 pass-1 relevance call + 4 pass-2 lens calls = 5 total
    expect(client.calls).toHaveLength(5);
    // All calls used the injected fake (no real network — ScriptedClient never throws)
  });

  it("records 0 LLM calls for filtered scope (pure JS, no LLM)", async () => {
    const findings = [
      makeFinding({ id: "f-medical", domain: "medical" }),
      makeFinding({ id: "f-finance", domain: "finance" }),
    ];
    const scope = parseScope({ mode: "filtered", domain: "medical" });
    const client = new ScriptedClient([]); // empty — would throw if called

    const result = await rankFindings(findings, scope, client, NOW);

    expect(client.calls).toHaveLength(0); // zero LLM calls for filtered mode
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("f-medical");
  });

  it("records (N_survivors × 4) pass-2 calls when some findings drop in pass-1", async () => {
    // 3 findings: 2 relevant, 1 irrelevant → only 2 make it to pass-2
    const f1 = makeFinding({ id: "f-1" });
    const f2 = makeFinding({ id: "f-2" });
    const f3 = makeFinding({ id: "f-3" });
    const scope = parseScope({ mode: "general" });

    // 3 relevance calls + 2 survivors × 4 lens calls = 3 + 8 = 11 calls
    const responses = [
      RELEVANT, RELEVANT, IRRELEVANT, // pass-1: f1 relevant, f2 relevant, f3 dropped
      INCLUDE_HIGH, INCLUDE_HIGH, INCLUDE_HIGH, INCLUDE_HIGH, // f1 lenses
      INCLUDE_MED,  INCLUDE_MED,  INCLUDE_MED,  INCLUDE_MED,  // f2 lenses
    ];
    const client = new ScriptedClient(responses);

    const result = await rankFindings([f1, f2, f3], scope, client, NOW);

    expect(client.calls).toHaveLength(11);
    expect(result).toHaveLength(2);
    expect(result.find((f) => f.id === "f-3")).toBeUndefined(); // f3 dropped in pass-1
  });

  it("handles garbage LLM output (null lens scores → fail-closed 0 score, finding flagged)", async () => {
    const finding = makeFinding({ id: "f-bad-lens" });
    const scope = parseScope({ mode: "general" });

    // All 4 lens responses are garbage → all null → all {include:false, score:0}
    // → passVotes=0, failVotes=4 → flagged-for-review; aggregateScore=0
    const responses = [RELEVANT, GARBAGE, GARBAGE, GARBAGE, GARBAGE];

    const result = await rankFindings([finding], scope, new ScriptedClient(responses), NOW);

    expect(result).toHaveLength(1);
    expect(result[0]?.tags).toContain("flagged-for-review");
    // Score should be 0 (garbage → 0 per lens)
  });
});
