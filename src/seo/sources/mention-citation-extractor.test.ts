/**
 * Unit tests for `DeterministicMentionCitationExtractor` (in-house-ai-
 * visibility, Sprint 2; sc-2-1).
 *
 * Pure/synchronous — no fakes needed beyond plain `GroundedCitation`
 * object literals.
 */
import { describe, it, expect } from "vitest";

import { DeterministicMentionCitationExtractor } from "./mention-citation-extractor.js";
import type { GroundedCitation } from "../../providers/grounded-search.js";

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
