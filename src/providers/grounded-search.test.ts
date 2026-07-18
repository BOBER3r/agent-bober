/**
 * Unit tests for `LiveGroundedSearchClient` (in-house-ai-visibility Sprint 1).
 *
 * Uses a hand-written scripted `LLMClient` (no `vi.mock`), mirroring
 * `structured.test.ts`'s `ScriptedClient` pattern but returning full
 * `ChatResponse` objects so `groundingCitations`/`costUsd` can be scripted.
 *
 * This file imports ONLY from `./types.js` and `./grounded-search.js` — no
 * `@anthropic-ai/sdk` or `openai` symbol anywhere (sc-1-4).
 */
import { describe, it, expect } from "vitest";

import type { ChatParams, ChatResponse, LLMClient } from "./types.js";
import { LiveGroundedSearchClient, PerplexitySonarClient, type GroundedEngine } from "./grounded-search.js";

// ── Scripted fake client ─────────────────────────────────────────────

class ScriptedClient implements LLMClient {
  readonly calls: ChatParams[] = [];
  private idx = 0;

  constructor(private readonly responses: ChatResponse[]) {}

  async chat(params: ChatParams): Promise<ChatResponse> {
    this.calls.push(params);
    const response = this.responses[Math.min(this.idx, this.responses.length - 1)];
    this.idx += 1;
    if (!response) {
      throw new Error("ScriptedClient: no response configured");
    }
    return response;
  }
}

function baseResponse(overrides: Partial<ChatResponse> = {}): ChatResponse {
  return {
    text: "The sky is blue due to Rayleigh scattering.",
    toolCalls: [],
    stopReason: "end",
    usage: { inputTokens: 10, outputTokens: 20 },
    ...overrides,
  };
}

// ── sc-1-2: anthropic citation mapping ───────────────────────────────

describe("LiveGroundedSearchClient — anthropic", () => {
  it("normalizes web_search_result_location citations to {url, title}, dropping cited_text", async () => {
    const client = new ScriptedClient([
      baseResponse({
        groundingCitations: [
          {
            url: "https://example.com/sky",
            title: "Why is the sky blue?",
            cited_text: "Rayleigh scattering causes the sky to appear blue.",
          },
        ],
      }),
    ]);
    const search = new LiveGroundedSearchClient("anthropic", client, "claude-sonnet-5");

    const answer = await search.search("Why is the sky blue?");

    expect(answer.answerText).toBe("The sky is blue due to Rayleigh scattering.");
    expect(answer.citations).toEqual([
      { url: "https://example.com/sky", title: "Why is the sky blue?" },
    ]);
    // cited_text must not leak into GroundedCitation.
    expect(answer.citations[0]).not.toHaveProperty("cited_text");
  });

  it("passes the prompt as the first user message and includes a web_search ToolDef", async () => {
    const client = new ScriptedClient([baseResponse()]);
    const search = new LiveGroundedSearchClient("anthropic", client, "claude-sonnet-5");

    await search.search("Why is the sky blue?");

    expect(client.calls).toHaveLength(1);
    const call = client.calls[0];
    expect(call?.messages[0]).toEqual({ role: "user", content: "Why is the sky blue?" });
    expect(call?.tools).toBeDefined();
    expect(call?.tools?.some((t) => t.name === "web_search")).toBe(true);
    expect(call?.tools?.find((t) => t.name === "web_search")?.readOnly).toBe(true);
  });

  it("threads locale into the request without changing the user prompt", async () => {
    const client = new ScriptedClient([baseResponse()]);
    const search = new LiveGroundedSearchClient("anthropic", client, "claude-sonnet-5");

    await search.search("local news today", "en-GB");

    const call = client.calls[0];
    expect(call?.messages[0]).toEqual({ role: "user", content: "local news today" });
    expect(call?.system).toContain("en-GB");
  });
});

// ── sc-1-2: openai citation mapping ──────────────────────────────────

describe("LiveGroundedSearchClient — openai", () => {
  it("normalizes url_citation annotations to {url, title}", async () => {
    const client = new ScriptedClient([
      baseResponse({
        groundingCitations: [
          { url: "https://openai-source.example.com/article", title: "OpenAI Source Article" },
        ],
      }),
    ]);
    const search = new LiveGroundedSearchClient("openai", client, "gpt-5");

    const answer = await search.search("What is grounding?");

    expect(answer.citations).toEqual([
      { url: "https://openai-source.example.com/article", title: "OpenAI Source Article" },
    ]);
  });

  it("falls back to the URL as title when the vendor omits a title", async () => {
    const client = new ScriptedClient([
      baseResponse({ groundingCitations: [{ url: "https://no-title.example.com" }] }),
    ]);
    const search = new LiveGroundedSearchClient("openai", client, "gpt-5");

    const answer = await search.search("no title source");

    expect(answer.citations).toEqual([
      { url: "https://no-title.example.com", title: "https://no-title.example.com" },
    ]);
  });
});

// ── sc-1-3: no grounding never throws, citations is [] ───────────────

describe("LiveGroundedSearchClient — no grounding", () => {
  it("returns citations: [] and does not throw when groundingCitations is absent", async () => {
    const client = new ScriptedClient([baseResponse()]);
    const search = new LiveGroundedSearchClient("anthropic", client, "claude-sonnet-5");

    await expect(search.search("ungrounded question")).resolves.toEqual({
      answerText: "The sky is blue due to Rayleigh scattering.",
      citations: [],
    });
  });

  it("returns citations: [] for the perplexity engine (Sprint 7 nonGoal) without throwing", async () => {
    const client = new ScriptedClient([
      baseResponse({ groundingCitations: [{ url: "https://perplexity.example.com", title: "x" }] }),
    ]);
    const engine: GroundedEngine = "perplexity";
    const search = new LiveGroundedSearchClient(engine, client, "sonar");

    const answer = await search.search("perplexity question");

    expect(answer.citations).toEqual([]);
  });
});

// ── costUsd pass-through ──────────────────────────────────────────────

describe("LiveGroundedSearchClient — costUsd pass-through", () => {
  it("passes costUsd through when the underlying ChatResponse sets it", async () => {
    const client = new ScriptedClient([baseResponse({ costUsd: 0.0042 })]);
    const search = new LiveGroundedSearchClient("anthropic", client, "claude-sonnet-5");

    const answer = await search.search("priced question");

    expect(answer.costUsd).toBe(0.0042);
  });

  it("omits the costUsd key (never sets it to undefined) when the ChatResponse has none", async () => {
    const client = new ScriptedClient([baseResponse()]);
    const search = new LiveGroundedSearchClient("anthropic", client, "claude-sonnet-5");

    const answer = await search.search("unpriced question");

    expect("costUsd" in answer).toBe(false);
  });
});

// ── sc-1-1: readonly engine + provider-agnostic types ─────────────────

describe("LiveGroundedSearchClient — engine identity", () => {
  it("exposes the injected engine as a readonly public property", () => {
    const client = new ScriptedClient([baseResponse()]);
    const search = new LiveGroundedSearchClient("openai", client, "gpt-5");

    expect(search.engine).toBe("openai");
  });
});

// ── PerplexitySonarClient (Sprint 7, sc-7-1..sc-7-4) ──────────────────
//
// A parallel fake TRANSPORT (not an `LLMClient`) — Perplexity Sonar is a
// direct HTTP `chat/completions` API. `fakeTransport` never opens a real
// socket; `calls` records every invocation so tests can assert the fake
// (not global `fetch`) was actually used (sc-7-3).

interface FakeTransportCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

function fakeTransport(payload: unknown, ok = true, status = 200) {
  const calls: FakeTransportCall[] = [];
  const transport = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body: string },
  ) => {
    calls.push({ url, init });
    return { ok, status, json: async () => payload };
  };
  return { transport, calls };
}

describe("PerplexitySonarClient — engine identity (sc-7-1)", () => {
  it("exposes engine as 'perplexity'", () => {
    const { transport } = fakeTransport({});
    const client = new PerplexitySonarClient(transport, () => "test-key");

    expect(client.engine).toBe("perplexity");
  });
});

describe("PerplexitySonarClient — citation mapping (sc-7-1)", () => {
  it("prefers search_results[{title,url}] over citations[], mapping to {url, title}", async () => {
    const { transport, calls } = fakeTransport({
      choices: [{ message: { content: "Casino X is a trusted operator." } }],
      citations: ["https://fallback.example.com"],
      search_results: [
        { title: "Casino X Review", url: "https://a.example.com/review" },
        { title: "Casino X News", url: "https://b.example.com/news" },
      ],
    });
    const client = new PerplexitySonarClient(transport, () => "test-key");

    const answer = await client.search("best casino");

    expect(answer.answerText).toBe("Casino X is a trusted operator.");
    expect(answer.citations).toEqual([
      { url: "https://a.example.com/review", title: "Casino X Review" },
      { url: "https://b.example.com/news", title: "Casino X News" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.perplexity.ai/chat/completions");
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.headers["Authorization"]).toBe("Bearer test-key");
  });

  it("falls back to a URL-doubles-as-title mapping of citations[] when search_results is absent", async () => {
    const { transport } = fakeTransport({
      choices: [{ message: { content: "Casino X is a trusted operator." } }],
      citations: ["https://fallback.example.com/a", "https://fallback.example.com/b"],
    });
    const client = new PerplexitySonarClient(transport, () => "test-key");

    const answer = await client.search("best casino");

    expect(answer.citations).toEqual([
      { url: "https://fallback.example.com/a", title: "https://fallback.example.com/a" },
      { url: "https://fallback.example.com/b", title: "https://fallback.example.com/b" },
    ]);
  });

  it("falls back to citations[] when search_results is present but empty", async () => {
    const { transport } = fakeTransport({
      choices: [{ message: { content: "text" } }],
      search_results: [],
      citations: ["https://only.example.com"],
    });
    const client = new PerplexitySonarClient(transport, () => "test-key");

    const answer = await client.search("q");

    expect(answer.citations).toEqual([{ url: "https://only.example.com", title: "https://only.example.com" }]);
  });

  it("returns citations: [] when both search_results and citations are absent (ungrounded)", async () => {
    const { transport } = fakeTransport({ choices: [{ message: { content: "no grounding available" } }] });
    const client = new PerplexitySonarClient(transport, () => "test-key");

    const answer = await client.search("ungrounded question");

    expect(answer).toEqual({ answerText: "no grounding available", citations: [] });
  });
});

describe("PerplexitySonarClient — never throws (sc-7-1, sc-7-3)", () => {
  it("degrades to an empty answer on an HTTP error response, without throwing", async () => {
    const { transport } = fakeTransport({ error: "rate limited" }, false, 429);
    const client = new PerplexitySonarClient(transport, () => "test-key");

    await expect(client.search("q")).resolves.toEqual({ answerText: "", citations: [] });
  });

  it("degrades to an empty answer on malformed JSON, without throwing", async () => {
    const transport = async () => ({
      ok: true,
      status: 200,
      json: async (): Promise<unknown> => {
        throw new Error("malformed JSON");
      },
    });
    const client = new PerplexitySonarClient(transport, () => "test-key");

    await expect(client.search("q")).resolves.toEqual({ answerText: "", citations: [] });
  });

  it("degrades to an empty answer without invoking the transport when no API key is configured", async () => {
    const { transport, calls } = fakeTransport({});
    const client = new PerplexitySonarClient(transport, () => undefined);

    const answer = await client.search("q");

    expect(answer).toEqual({ answerText: "", citations: [] });
    expect(calls).toHaveLength(0);
  });

  it("omits the costUsd key (never sets it to undefined)", async () => {
    const { transport } = fakeTransport({
      choices: [{ message: { content: "text" } }],
      search_results: [{ title: "T", url: "https://example.com" }],
    });
    const client = new PerplexitySonarClient(transport, () => "test-key");

    const answer = await client.search("q");

    expect("costUsd" in answer).toBe(false);
  });
});

describe("PerplexitySonarClient — no real network (sc-7-3)", () => {
  it("uses only the injected transport, never the real global fetch", async () => {
    const { transport, calls } = fakeTransport({
      choices: [{ message: { content: "ok" } }],
      citations: ["https://example.com"],
    });
    const client = new PerplexitySonarClient(transport, () => "test-key");

    await client.search("q", "en-GB");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.headers["Content-Type"]).toBe("application/json");
    expect(calls[0]?.init.body).toContain("en-GB");
    expect(calls[0]?.init.body).toContain("\"q\"");
  });
});
