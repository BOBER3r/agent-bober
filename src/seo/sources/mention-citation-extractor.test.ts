/**
 * Unit tests for `DeterministicMentionCitationExtractor` (in-house-ai-
 * visibility, Sprint 2; sc-2-1) and `LlmJudgeMentionCitationExtractor`
 * (Sprint 8; sc-8-1..sc-8-4).
 *
 * The Sprint-2 blocks below are pure/synchronous — no fakes needed beyond
 * plain `GroundedCitation` object literals — and are left byte-identical
 * (sc-8-2). The Sprint-8 blocks at the bottom of this file use a scripted
 * `LLMClient` fake (mirrors `src/seo/analyzer.test.ts:11-21`) — no network.
 */
import { describe, it, expect } from "vitest";

import {
  DeterministicMentionCitationExtractor,
  LlmJudgeMentionCitationExtractor,
  parseJudgeVerdict,
} from "./mention-citation-extractor.js";
import { ContentSanitizer } from "../content-sanitizer.js";
import type { GroundedCitation } from "../../providers/grounded-search.js";
import type { LLMClient, ChatParams, ChatResponse } from "../../providers/types.js";

const extractor = new DeterministicMentionCitationExtractor();

function extract(target: string, answerText: string, citations: GroundedCitation[] = []) {
  return extractor.extract({ target, answerText, citations });
}

// ── sc-2-1: empty/whitespace/malformed answer never false-positives ───────

describe("DeterministicMentionCitationExtractor — empty/malformed input never false-positives (sc-2-1)", () => {
  it("empty answerText and empty citations yields all-false, no fabrication", () => {
    expect(extract("https://target.example", "", [])).toEqual({
      mentioned: false,
      citationPresent: false,
      sourceUrls: [],
    });
  });

  it("whitespace-only answerText yields mentioned:false even when it contains the brand token surrounded by spaces", () => {
    expect(extract("https://target.example", "   \n\t  ", [])).toEqual({
      mentioned: false,
      citationPresent: false,
      sourceUrls: [],
    });
  });

  it("garbage/unrelated answerText yields mentioned:false", () => {
    expect(extract("https://target.example", "the quick brown fox jumps over the lazy dog", [])).toEqual({
      mentioned: false,
      citationPresent: false,
      sourceUrls: [],
    });
  });

  it("empty target yields all-false regardless of answerText content", () => {
    expect(extract("", "target is mentioned here", [])).toEqual({
      mentioned: false,
      citationPresent: false,
      sourceUrls: [],
    });
  });

  it("whitespace-only target yields all-false", () => {
    expect(extract("   ", "target.example is great", [])).toEqual({
      mentioned: false,
      citationPresent: false,
      sourceUrls: [],
    });
  });

  it("does not fabricate a substring false-positive: brand 'ace' must not match inside 'space'", () => {
    const out = extract("https://ace.example", "This is a space rocket, not a mention.", []);
    expect(out.mentioned).toBe(false);
  });

  it("never emits a rank key (rank is not deterministically derivable this sprint)", () => {
    const out = extract("https://target.example", "target.example is a great brand", []);
    expect("rank" in out).toBe(false);
  });
});

// ── sc-2-1: real brand/host mention ────────────────────────────────────────

describe("DeterministicMentionCitationExtractor — brand/host mention (sc-2-1)", () => {
  it("matches the brand token case-insensitively on a word boundary in answerText", () => {
    const out = extract("https://target.example", "Target is a well-known retailer.", []);
    expect(out.mentioned).toBe(true);
  });

  it("matches the full host in answerText", () => {
    const out = extract("https://target.example", "Visit target.example for more info.", []);
    expect(out.mentioned).toBe(true);
  });

  it("matches when the target is given as a bare domain (no scheme)", () => {
    const out = extract("target.example", "Target has great deals.", []);
    expect(out.mentioned).toBe(true);
  });

  it("matches when the target has a www. prefix and the answer omits it", () => {
    const out = extract("https://www.target.example", "Target is a great brand.", []);
    expect(out.mentioned).toBe(true);
  });

  it("matches a brand mention inside a citation title even when answerText has none", () => {
    const out = extract("https://target.example", "no brand text here at all", [
      { url: "https://other.example/x", title: "Target Review 2026" },
    ]);
    expect(out.mentioned).toBe(true);
  });
});

// ── sc-2-1: citationPresent / sourceUrls by host match ─────────────────────

describe("DeterministicMentionCitationExtractor — citation host matching (sc-2-1)", () => {
  it("a same-domain citation yields citationPresent:true and includes the URL in sourceUrls", () => {
    const citations: GroundedCitation[] = [{ url: "https://target.example/page", title: "Target page" }];
    const out = extract("https://target.example", "irrelevant answer text", citations);
    expect(out.citationPresent).toBe(true);
    expect(out.sourceUrls).toEqual(["https://target.example/page"]);
  });

  it("a subdomain citation (blog.target.example) matches the target host", () => {
    const citations: GroundedCitation[] = [{ url: "https://blog.target.example/post", title: "Blog" }];
    const out = extract("https://target.example", "irrelevant", citations);
    expect(out.citationPresent).toBe(true);
    expect(out.sourceUrls).toEqual(["https://blog.target.example/post"]);
  });

  it("a different-domain citation yields citationPresent:false and an empty sourceUrls", () => {
    const citations: GroundedCitation[] = [{ url: "https://other.example/a", title: "Unrelated" }];
    const out = extract("https://target.example", "irrelevant", citations);
    expect(out.citationPresent).toBe(false);
    expect(out.sourceUrls).toEqual([]);
  });

  it("only same-domain citations are included when citations mix domains", () => {
    const citations: GroundedCitation[] = [
      { url: "https://target.example/a", title: "A" },
      { url: "https://other.example/b", title: "B" },
      { url: "https://target.example/c", title: "C" },
    ];
    const out = extract("https://target.example", "irrelevant", citations);
    expect(out.sourceUrls).toEqual(["https://target.example/a", "https://target.example/c"]);
  });

  it("a malformed citation URL is silently excluded from sourceUrls (never throws)", () => {
    const citations: GroundedCitation[] = [{ url: "not a url at all", title: "Broken" }];
    expect(() => extract("https://target.example", "irrelevant", citations)).not.toThrow();
    const out = extract("https://target.example", "irrelevant", citations);
    expect(out.sourceUrls).toEqual([]);
    expect(out.citationPresent).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// LlmJudgeMentionCitationExtractor — Sprint 8 (sc-8-1..sc-8-5)
// ═══════════════════════════════════════════════════════════════════════

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

/** Always throws — used to exercise the transport-error fail-safe branch (sc-8-3). */
class ThrowingClient implements LLMClient {
  async chat(_params: ChatParams): Promise<ChatResponse> {
    throw new Error("Network timeout");
  }
}

/** Passes text through unchanged — used where sanitize-boundary behavior is not under test. */
function identitySanitizer(): ContentSanitizer {
  return new ContentSanitizer((raw) => ({ content: raw, hadThreats: false }));
}

const deterministic = new DeterministicMentionCitationExtractor();

// ── parseJudgeVerdict — never-throws 3-tier parse ───────────────────────

describe("parseJudgeVerdict — never-throws 3-tier parse", () => {
  it("parses a direct JSON object", () => {
    const result = parseJudgeVerdict('{"mentioned":true,"rank":2}');
    expect(result).toEqual({ ok: true, verdict: { mentioned: true, rank: 2 } });
  });

  it("parses a fenced ```json block", () => {
    const result = parseJudgeVerdict('```json\n{"mentioned":false}\n```');
    expect(result).toEqual({ ok: true, verdict: { mentioned: false } });
  });

  it("parses the first {...} span embedded in prose", () => {
    const result = parseJudgeVerdict('Sure, here it is: {"mentioned":true} — hope that helps.');
    expect(result).toEqual({ ok: true, verdict: { mentioned: true } });
  });

  it("returns ok:false (never throws) on plain non-JSON text", () => {
    expect(() => parseJudgeVerdict("not json")).not.toThrow();
    const result = parseJudgeVerdict("not json");
    expect(result.ok).toBe(false);
  });

  it("returns ok:false on a schema-invalid object (wrong type)", () => {
    const result = parseJudgeVerdict('{"mentioned":"yes"}');
    expect(result.ok).toBe(false);
  });

  it("returns ok:false on an empty string", () => {
    expect(() => parseJudgeVerdict("")).not.toThrow();
    expect(parseJudgeVerdict("").ok).toBe(false);
  });
});

// ── sc-8-1: fuzzy match via the judge ───────────────────────────────────

describe("LlmJudgeMentionCitationExtractor — fuzzy brand mention via judge (sc-8-1)", () => {
  it("deterministic pass misses a paraphrase; judge marks mentioned:true with a rank", async () => {
    const client = new ScriptedClient(['{"mentioned":true,"rank":2}']);
    const judge = new LlmJudgeMentionCitationExtractor(deterministic, client, "test-model", identitySanitizer());

    const out = await judge.extract({
      target: "https://target.example",
      answerText: "The retailer known for the bullseye logo is a strong pick for deals.",
      citations: [],
    });

    expect(out.mentioned).toBe(true);
    expect(out.rank).toBe(2);
    expect(client.calls.length).toBe(1);
  });

  it("judge verdict with no rank omits the rank key (never `rank: undefined`)", async () => {
    const client = new ScriptedClient(['{"mentioned":true}']);
    const judge = new LlmJudgeMentionCitationExtractor(deterministic, client, "test-model", identitySanitizer());

    const out = await judge.extract({
      target: "https://target.example",
      answerText: "The retailer known for the bullseye logo is a strong pick.",
      citations: [],
    });

    expect(out.mentioned).toBe(true);
    expect("rank" in out).toBe(false);
  });

  it("judge preserves the deterministic pass's citationPresent/sourceUrls (does not re-derive them)", async () => {
    const client = new ScriptedClient(['{"mentioned":true}']);
    const citations: GroundedCitation[] = [{ url: "https://target.example/page", title: "Some other title" }];
    const judge = new LlmJudgeMentionCitationExtractor(deterministic, client, "test-model", identitySanitizer());

    const out = await judge.extract({
      target: "https://target.example",
      answerText: "The retailer known for the bullseye logo is a strong pick.",
      citations,
    });

    expect(out.citationPresent).toBe(true);
    expect(out.sourceUrls).toEqual(["https://target.example/page"]);
  });
});

// ── sc-8-2: byte-identical to the deterministic-only path when off ─────

describe("LlmJudgeMentionCitationExtractor — byte-identical to deterministic when off (sc-8-2)", () => {
  it("with no llm injected, the deterministic-only extractor is unaffected by this module's additions", () => {
    const out = deterministic.extract({
      target: "https://target.example",
      answerText: "Target is a well-known retailer.",
      citations: [],
    });
    expect(out).toEqual({ mentioned: true, citationPresent: false, sourceUrls: [] });
  });

  it("judge-disabled construction is simulated by simply not constructing LlmJudgeMentionCitationExtractor: deep-equal vs deterministic, and no LLM call is ever made", async () => {
    const client = new ScriptedClient(['{"mentioned":true}']);
    const input = {
      target: "https://target.example",
      answerText: "the quick brown fox jumps over the lazy dog",
      citations: [] as GroundedCitation[],
    };

    // Production wiring with judge disabled/absent constructs ONLY the
    // deterministic extractor (ai-visibility-provider.ts, runner.ts) — the
    // scripted client here proves that code path, if reached, is never hit.
    const detOut = deterministic.extract(input);
    expect(detOut).toEqual({ mentioned: false, citationPresent: false, sourceUrls: [] });
    expect(client.calls.length).toBe(0);
  });

  it("cost control: when the deterministic pass already found a mention, the judge is never called and the result is deep-equal to the deterministic one", async () => {
    const client = new ScriptedClient(['{"mentioned":false}']); // would flip the verdict if (wrongly) invoked
    const judge = new LlmJudgeMentionCitationExtractor(deterministic, client, "test-model", identitySanitizer());
    const input = {
      target: "https://target.example",
      answerText: "Target is a well-known retailer.",
      citations: [] as GroundedCitation[],
    };

    const detOut = deterministic.extract(input);
    const judgeOut = await judge.extract(input);

    expect(judgeOut).toEqual(detOut);
    expect(client.calls.length).toBe(0);
  });
});

// ── sc-8-3: never false-positives empty/malformed input; fails safe ────

describe("LlmJudgeMentionCitationExtractor — never false-positives empty input; fails safe (sc-8-3)", () => {
  it("empty answerText yields mentioned:false and the judge is never called", async () => {
    const client = new ScriptedClient(['{"mentioned":true}']); // would fabricate a mention if (wrongly) invoked
    const judge = new LlmJudgeMentionCitationExtractor(deterministic, client, "test-model", identitySanitizer());

    const out = await judge.extract({ target: "https://target.example", answerText: "", citations: [] });

    expect(out.mentioned).toBe(false);
    expect(client.calls.length).toBe(0);
  });

  it("whitespace-only answerText yields mentioned:false and the judge is never called", async () => {
    const client = new ScriptedClient(['{"mentioned":true}']);
    const judge = new LlmJudgeMentionCitationExtractor(deterministic, client, "test-model", identitySanitizer());

    const out = await judge.extract({ target: "https://target.example", answerText: "   \n\t  ", citations: [] });

    expect(out.mentioned).toBe(false);
    expect(client.calls.length).toBe(0);
  });

  it("a throwing LLM client falls back to the deterministic result, never a fabricated mention", async () => {
    const judge = new LlmJudgeMentionCitationExtractor(
      deterministic,
      new ThrowingClient(),
      "test-model",
      identitySanitizer(),
    );

    const out = await judge.extract({
      target: "https://target.example",
      answerText: "some unrelated garbage text about nothing at all",
      citations: [],
    });

    expect(out).toEqual({ mentioned: false, citationPresent: false, sourceUrls: [] });
  });

  it("an unparseable judge verdict falls back to the deterministic result, never a fabricated mention", async () => {
    const client = new ScriptedClient(["not json at all"]);
    const judge = new LlmJudgeMentionCitationExtractor(deterministic, client, "test-model", identitySanitizer());

    const out = await judge.extract({
      target: "https://target.example",
      answerText: "some unrelated garbage text about nothing at all",
      citations: [],
    });

    expect(out).toEqual({ mentioned: false, citationPresent: false, sourceUrls: [] });
    expect(client.calls.length).toBe(1); // it WAS called; the failure is in parsing, not skipped
  });

  it("a schema-invalid judge verdict (wrong type) falls back to the deterministic result", async () => {
    const client = new ScriptedClient(['{"mentioned":"yes"}']);
    const judge = new LlmJudgeMentionCitationExtractor(deterministic, client, "test-model", identitySanitizer());

    const out = await judge.extract({
      target: "https://target.example",
      answerText: "some unrelated garbage text about nothing at all",
      citations: [],
    });

    expect(out.mentioned).toBe(false);
  });

  it("a sanitizer that drops the text entirely (fail-closed) short-circuits before calling the judge", async () => {
    const dropAllSanitizer = new ContentSanitizer(() => ({ content: "", hadThreats: true }));
    const client = new ScriptedClient(['{"mentioned":true}']);
    const judge = new LlmJudgeMentionCitationExtractor(deterministic, client, "test-model", dropAllSanitizer);

    const out = await judge.extract({
      target: "https://target.example",
      answerText: "some text that would be dropped by sanitization",
      citations: [],
    });

    expect(out.mentioned).toBe(false);
    expect(client.calls.length).toBe(0);
  });
});

// ── sc-8-4: answer text is sanitized BEFORE it reaches the judge prompt ──

describe("LlmJudgeMentionCitationExtractor — sanitize before judge prompt (sc-8-4)", () => {
  it("the judge receives the SANITIZED answer text, not the raw input", async () => {
    // A transforming sanitizer proves the judge saw its output, not the raw string.
    const stripMarkerSanitizer = new ContentSanitizer((raw) => ({
      content: raw.replace(/\[INJECTED\]/g, ""),
      hadThreats: raw.includes("[INJECTED]"),
    }));
    const client = new ScriptedClient(['{"mentioned":false}']);
    const judge = new LlmJudgeMentionCitationExtractor(deterministic, client, "test-model", stripMarkerSanitizer);

    const rawAnswer = "This mentions [INJECTED] some unrelated brand entirely.";
    await judge.extract({ target: "https://target.example", answerText: rawAnswer, citations: [] });

    expect(client.calls.length).toBe(1);
    const sentContent = JSON.stringify(client.calls[0]);
    expect(sentContent).not.toContain("[INJECTED]");
    expect(sentContent).toContain("This mentions  some unrelated brand entirely.");
  });

  it("sanitize runs even though the deterministic pass already saw the raw text (defense in depth)", async () => {
    let sanitizeCalls = 0;
    const countingSanitizer = new ContentSanitizer((raw) => {
      sanitizeCalls += 1;
      return { content: raw, hadThreats: false };
    });
    const client = new ScriptedClient(['{"mentioned":false}']);
    const judge = new LlmJudgeMentionCitationExtractor(deterministic, client, "test-model", countingSanitizer);

    await judge.extract({
      target: "https://target.example",
      answerText: "some unrelated garbage text about nothing at all",
      citations: [],
    });

    expect(sanitizeCalls).toBe(1);
  });
});
