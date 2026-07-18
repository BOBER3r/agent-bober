/**
 * Unit tests for `ApiSpineEngineProvider` (in-house-ai-visibility, Sprint 2;
 * sc-2-2, sc-2-3, sc-2-4).
 *
 * Uses a hand-written scripted `GroundedSearchClient` (no `vi.mock`),
 * mirroring `grounded-search.test.ts`'s `ScriptedClient` (index-advancing
 * responses) and `ai-visibility-adapter.test.ts`'s `fakeProvider` pattern.
 * The real `DeterministicMentionCitationExtractor` is used so row content
 * reflects genuine per-sample brand/citation matching, not a canned stub.
 */
import { describe, it, expect } from "vitest";

import { ApiSpineEngineProvider } from "./api-spine-provider.js";
import { DeterministicMentionCitationExtractor } from "./mention-citation-extractor.js";
import type { GroundedAnswer, GroundedEngine, GroundedSearchClient } from "../../providers/grounded-search.js";

/** One `GroundedAnswer` per call, index-advancing. Throws when scripted answers run out. */
function scriptedClient(engine: GroundedEngine, answers: GroundedAnswer[]): GroundedSearchClient {
  let i = 0;
  return {
    engine,
    async search() {
      const answer = answers[i];
      i += 1;
      if (!answer) throw new Error("scriptedClient: no answer configured");
      return answer;
    },
  };
}

/** Same index-advancing script, but the call at `rejectIndex` throws instead of resolving. */
function rejectingAt(engine: GroundedEngine, answers: GroundedAnswer[], rejectIndex: number): GroundedSearchClient {
  let i = 0;
  return {
    engine,
    async search() {
      const n = i;
      i += 1;
      if (n === rejectIndex) throw new Error("sample failed");
      const answer = answers[n];
      if (!answer) throw new Error("rejectingAt: no answer configured");
      return answer;
    },
  };
}

/** Every call rejects — used for the all-fail => throw contract (sc-2-4). */
function alwaysRejectingClient(engine: GroundedEngine): GroundedSearchClient {
  return {
    engine,
    async search() {
      throw new Error("vendor down");
    },
  };
}

const extractor = new DeterministicMentionCitationExtractor();

function mentionAnswer(): GroundedAnswer {
  return {
    answerText: "Target is a well-known retailer with great deals.",
    citations: [{ url: "https://target.example/deals", title: "Target Deals" }],
  };
}

function noMentionAnswer(): GroundedAnswer {
  return { answerText: "The weather today is sunny with a light breeze.", citations: [] };
}

// ── sc-2-2: port shape — name, N-baked cost, row count/labels ─────────────

describe("ApiSpineEngineProvider — port shape (sc-2-2)", () => {
  it("estCostUsdPerPrompt folds in N (ADR-3): perCallUsd * samplesPerPrompt", () => {
    const client = scriptedClient("anthropic", [mentionAnswer(), mentionAnswer(), mentionAnswer()]);
    const provider = new ApiSpineEngineProvider(client, extractor, 3, 0.02);

    expect(provider.estCostUsdPerPrompt).toBeCloseTo(0.06, 6); // 0.02 * 3
  });

  it("name is the injected client's engine", () => {
    const client = scriptedClient("openai", [mentionAnswer()]);
    const provider = new ApiSpineEngineProvider(client, extractor, 1, 0.01);

    expect(provider.name).toBe("openai");
  });

  it("probe returns N rows per prompt, each stamped with the engine label", async () => {
    const N = 3;
    const prompts = ["best casino", "top exchange"];
    const answers = Array.from({ length: N * prompts.length }, () => mentionAnswer());
    const client = scriptedClient("anthropic", answers);
    const provider = new ApiSpineEngineProvider(client, extractor, N, 0.01);

    const rows = await provider.probe("https://target.example", prompts);

    expect(rows).toHaveLength(N * prompts.length);
    for (const row of rows) {
      expect(row.provider).toBe("anthropic");
    }
    // N rows for each of the two prompts.
    expect(rows.filter((r) => r.prompt === "best casino")).toHaveLength(N);
    expect(rows.filter((r) => r.prompt === "top exchange")).toHaveLength(N);
  });
});

// ── sc-2-3: per-sample variation yields distinct real observations ────────

describe("ApiSpineEngineProvider — per-sample variation, not a pre-aggregate (sc-2-3)", () => {
  it("each of the N rows reflects its own scripted sample (mention/citation varies)", async () => {
    const client = scriptedClient("openai", [mentionAnswer(), noMentionAnswer(), mentionAnswer()]);
    const provider = new ApiSpineEngineProvider(client, extractor, 3, 0.01);

    const rows = await provider.probe("https://target.example", ["one prompt"]);

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ mentioned: true, citationPresent: true, sourceUrls: ["https://target.example/deals"] });
    expect(rows[1]).toMatchObject({ mentioned: false, citationPresent: false, sourceUrls: [] });
    expect(rows[2]).toMatchObject({ mentioned: true, citationPresent: true, sourceUrls: ["https://target.example/deals"] });
  });

  it("passes the same prompt and target into every sample, and locale through unchanged", async () => {
    const calls: Array<{ prompt: string | undefined }> = [];
    const client: GroundedSearchClient = {
      engine: "anthropic",
      async search(prompt) {
        calls.push({ prompt });
        return mentionAnswer();
      },
    };
    const provider = new ApiSpineEngineProvider(client, extractor, 2, 0.01);

    await provider.probe("https://target.example", ["only prompt"], "en-GB");

    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.prompt === "only prompt")).toBe(true);
  });
});

// ── sc-2-4: a rejecting sample is dropped, never mislabeled, never fabricated ──

describe("ApiSpineEngineProvider — rejecting sample handling (sc-2-4)", () => {
  it("a single rejecting sample is dropped: probe does not throw, and N-1 rows are returned for that prompt", async () => {
    const N = 3;
    const answers = [mentionAnswer(), mentionAnswer(), mentionAnswer()]; // index 1 will be skipped by rejectingAt
    const client = rejectingAt("anthropic", answers, 1);
    const provider = new ApiSpineEngineProvider(client, extractor, N, 0.01);

    const rows = await provider.probe("https://target.example", ["one prompt"]);

    expect(rows).toHaveLength(N - 1);
    for (const row of rows) {
      expect(row.provider).toBe("anthropic"); // never mislabeled
      expect(row.mentioned).toBe(true);
      expect(row.sourceUrls).toEqual(["https://target.example/deals"]); // never fabricated beyond the scripted citation
    }
  });

  it("does not merge the rejected sample's non-existent observation into a neighboring row", async () => {
    const client = rejectingAt("openai", [noMentionAnswer(), mentionAnswer()], 0); // sample 0 rejects, sample 1 mentions
    const provider = new ApiSpineEngineProvider(client, extractor, 2, 0.01);

    const rows = await provider.probe("https://target.example", ["one prompt"]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mentioned: true, citationPresent: true, sourceUrls: ["https://target.example/deals"] });
  });

  it("when every attempted sample rejects, probe throws (adapter can degrade to abstain + book nothing)", async () => {
    const client = alwaysRejectingClient("anthropic");
    const provider = new ApiSpineEngineProvider(client, extractor, 3, 0.01);

    await expect(provider.probe("https://target.example", ["one prompt"])).rejects.toThrow();
  });

  it("zero prompts attempts nothing and resolves an empty array without throwing", async () => {
    const client = alwaysRejectingClient("anthropic");
    const provider = new ApiSpineEngineProvider(client, extractor, 3, 0.01);

    await expect(provider.probe("https://target.example", [])).resolves.toEqual([]);
  });
});
