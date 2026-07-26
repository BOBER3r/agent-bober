import { describe, it, expect } from "vitest";

import { PerplexityUiScrapeParser } from "./engine-scrape-parser-perplexity.js";

const parser = new PerplexityUiScrapeParser();

// ── sc-11-1: pure fn RawScrape -> ParsedAnswer{answerText, citations} ──────

describe("PerplexityUiScrapeParser — pure markdown -> {answerText, citations} (sc-11-1)", () => {
  it("extracts the answer prose and the markdown-link citations from a typical perplexity-ui answer page (inline numbered refs)", () => {
    const markdown = [
      "Target.example[1] is one of the most popular casino review sites, known for",
      "in-depth reviews and fast payout guides[2].",
      "",
      "### Sources",
      "1. [Target.example Reviews](https://target.example/reviews)",
      "2. [About Target](https://target.example/about)",
    ].join("\n");

    const out = parser.parse({ url: "https://www.perplexity.ai/search/abc", markdown });

    expect(out.answerText).toBe(
      "Target.example[1] is one of the most popular casino review sites, known for\nin-depth reviews and fast payout guides[2].",
    );
    expect(out.citations).toEqual([
      { url: "https://target.example/reviews", title: "Target.example Reviews" },
      { url: "https://target.example/about", title: "About Target" },
    ]);
  });

  it("returns the whole trimmed markdown as answerText when no sources/citations/references heading is present", () => {
    const markdown = "Just a plain answer with no citation block at all.";
    const out = parser.parse({ url: "https://www.perplexity.ai/search/abc", markdown });
    expect(out.answerText).toBe("Just a plain answer with no citation block at all.");
    expect(out.citations).toEqual([]);
  });

  it("recognizes 'Citations' and 'References' headings too (case-insensitive)", () => {
    const withCitations = parser.parse({
      url: "u",
      markdown: "Answer body.\n\nCitations:\n[Ref](https://a.example/1)",
    });
    expect(withCitations.answerText).toBe("Answer body.");
    expect(withCitations.citations).toEqual([{ url: "https://a.example/1", title: "Ref" }]);

    const withReferences = parser.parse({
      url: "u",
      markdown: "Answer body.\n\nREFERENCES\n[Ref](https://a.example/2)",
    });
    expect(withReferences.answerText).toBe("Answer body.");
    expect(withReferences.citations).toEqual([{ url: "https://a.example/2", title: "Ref" }]);
  });

  it("captures a bare autolink citation with the url as its own title", () => {
    const out = parser.parse({ url: "u", markdown: "See <https://target.example/deals> for details." });
    expect(out.citations).toEqual([{ url: "https://target.example/deals", title: "https://target.example/deals" }]);
  });

  it("captures a bare (unlinked) URL as a fallback citation", () => {
    const out = parser.parse({ url: "u", markdown: "Visit https://target.example/promo today." });
    expect(out.citations).toEqual([{ url: "https://target.example/promo", title: "https://target.example/promo" }]);
  });

  it("deduplicates citations by url, keeping the first-seen title", () => {
    const markdown = [
      "Answer referencing the same page twice.",
      "[First mention](https://target.example/page)",
      "[Second mention](https://target.example/page)",
    ].join("\n");
    const out = parser.parse({ url: "u", markdown });
    expect(out.citations).toEqual([{ url: "https://target.example/page", title: "First mention" }]);
  });

  it("falls back to the url as title when the markdown link has empty link text", () => {
    const out = parser.parse({ url: "u", markdown: "[](https://target.example/empty-title)" });
    expect(out.citations).toEqual([{ url: "https://target.example/empty-title", title: "https://target.example/empty-title" }]);
  });

  it("skips a malformed/unusable link href without throwing", () => {
    expect(() => parser.parse({ url: "u", markdown: "[Broken](not a url at all)" })).not.toThrow();
    const out = parser.parse({ url: "u", markdown: "[Broken](not a url at all)" });
    expect(out.citations).toEqual([]);
  });

  // ── never fabricates a positive observation on empty/malformed input ────

  it("empty markdown yields { answerText: '', citations: [] }", () => {
    expect(parser.parse({ url: "u", markdown: "" })).toEqual({ answerText: "", citations: [] });
  });

  it("whitespace-only markdown yields { answerText: '', citations: [] }", () => {
    expect(parser.parse({ url: "u", markdown: "   \n\t  " })).toEqual({ answerText: "", citations: [] });
  });

  it("garbage/malformed markdown never throws and degrades gracefully", () => {
    const garbage = "]]] [[[ (((unbalanced))) <<< >>> \x00\x01 not-a-link(";
    expect(() => parser.parse({ url: "u", markdown: garbage })).not.toThrow();
    const out = parser.parse({ url: "u", markdown: garbage });
    expect(out.answerText).toBe(garbage);
    expect(out.citations).toEqual([]);
  });

  it("a missing markdown field never throws (parser drift tolerance)", () => {
    const malformedRaw = { url: "u" } as unknown as { url: string; markdown: string };
    expect(() => parser.parse(malformedRaw)).not.toThrow();
    expect(parser.parse(malformedRaw)).toEqual({ answerText: "", citations: [] });
  });
});
