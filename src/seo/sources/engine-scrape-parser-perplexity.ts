/**
 * PerplexityUiScrapeParser — PURE, network-free transform from raw scraped
 * Perplexity-UI answer-page markdown into a normalized `ParsedAnswer`
 * (in-house-ai-visibility, Sprint 11; arch-20260717-in-house-oss-ai-
 * visibility-architecture.md:139-141,250-251,281).
 *
 * This module has ZERO dependencies on damcrawler, egress, or any network
 * primitive — it is a synchronous, deterministic markdown -> data mapping,
 * mirroring `ChatgptUiScrapeParser`'s (`./engine-scrape-parser-chatgpt.ts`)
 * "PURE, synchronous, network-free transform" contract. `ScrapeArmEngineProvider`
 * is the ONLY caller, and it invokes `.parse()` strictly AFTER the raw
 * scraped markdown has already passed through the fail-closed
 * `ContentSanitizer` at the network->in-process boundary (Sprint-9 F1
 * lesson) — this parser never sees unsanitized text in production, but it
 * does not (and must not) assume that; it never throws regardless of input.
 *
 * The `RawScrape`/`ParsedAnswer`/`EngineScrapeParser` types are SHARED with
 * the chatgpt parser (imported from `./engine-scrape-parser-chatgpt.js`,
 * never redefined) — both parsers implement the same seam over the SAME
 * `dam.scrape()` output shape `{ url, title, markdown }`, even though a
 * Perplexity answer page's rendered layout differs (Perplexity renders
 * inline `[1]`/`[2]` numbered refs plus a trailing "Sources"/"Citations"
 * block, rather than ChatGPT-UI's shape) — the SAME generic markdown-shape
 * heuristics (strip a trailing sources block; extract markdown links,
 * autolinks, and bare URLs; dedup by url) apply unchanged.
 *
 * Perplexity's exported/rendered answer-page markdown is NOT a stable,
 * fully documented format — this parser degrades gracefully on drift:
 * "parser drift => empty answerText => downstream observation counts as
 * not-mentioned" (arch:281) is the explicit contract, not a bug to fix
 * later. Empty/whitespace/malformed input always yields `{ answerText: "",
 * citations: [] }` — this class NEVER fabricates a positive observation.
 *
 * Extraction strategy (deterministic, markdown-shape heuristics only,
 * identical to `ChatgptUiScrapeParser`):
 *   1. `answerText` — the raw markdown with any trailing "Sources"/
 *      "Citations" section (and any markdown link syntax) stripped, then
 *      trimmed. A Perplexity-UI answer page renders the assistant's prose
 *      followed by an optional sources block; this parser treats everything
 *      before that block (or the whole trimmed text, when no block is
 *      found) as the answer.
 *   2. `citations` — markdown links (`[title](url)`) found ANYWHERE in the
 *      raw markdown, deduplicated by URL, mapped to `GroundedCitation`
 *      `{ url, title }`. A bare autolink (`<https://...>`) or a bare URL is
 *      also captured with its url as its own title (no better title is
 *      derivable). Malformed/empty href or link text never crashes the
 *      parser — such candidates are simply skipped.
 */
import type { GroundedCitation } from "../../providers/grounded-search.js";
import type { EngineScrapeParser, RawScrape, ParsedAnswer } from "./engine-scrape-parser-chatgpt.js";

/** Heading text (case-insensitive) that marks the start of a trailing sources/citations block. */
const SOURCES_HEADING = /^#{0,6}\s*(sources|citations|references)\s*:?\s*$/im;

/** Markdown inline link: `[title](url)`. Title may be empty; url must be non-whitespace. */
const MARKDOWN_LINK = /\[([^\]]*)\]\(\s*(\S+?)\s*(?:"[^"]*")?\s*\)/g;

/** Bare autolink: `<https://example.com>`. */
const AUTOLINK = /<((?:https?:\/\/)[^\s<>]+)>/g;

/** Bare URL not already captured by the two patterns above (best-effort fallback). */
const BARE_URL = /(?<![("<])\bhttps?:\/\/[^\s)\]"'<>]+/g;

/** `try { new URL(...) } catch { false }` — never throws; rejects a candidate url as unusable. */
function isUsableUrl(candidate: string): boolean {
  try {
    new URL(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Strips a trailing "Sources"/"Citations"/"References" heading and
 * everything after it, returning only the prose above it. When no such
 * heading is found, returns the input unchanged (the whole text is prose).
 */
function stripTrailingSourcesBlock(markdown: string): string {
  const match = SOURCES_HEADING.exec(markdown);
  if (!match) return markdown;
  return markdown.slice(0, match.index);
}

/**
 * Extracts every distinct citation link from the raw markdown — markdown
 * links first, then autolinks, then bare URLs — deduplicated by URL
 * (first-seen title wins). Never throws on malformed link syntax.
 */
function extractCitations(markdown: string): GroundedCitation[] {
  const seen = new Set<string>();
  const citations: GroundedCitation[] = [];

  const addCandidate = (url: string, title: string): void => {
    const trimmedUrl = url.trim();
    if (!trimmedUrl || !isUsableUrl(trimmedUrl) || seen.has(trimmedUrl)) return;
    seen.add(trimmedUrl);
    const trimmedTitle = title.trim();
    citations.push({ url: trimmedUrl, title: trimmedTitle.length > 0 ? trimmedTitle : trimmedUrl });
  };

  for (const m of markdown.matchAll(MARKDOWN_LINK)) {
    addCandidate(m[2] ?? "", m[1] ?? "");
  }
  for (const m of markdown.matchAll(AUTOLINK)) {
    addCandidate(m[1] ?? "", m[1] ?? "");
  }
  for (const m of markdown.matchAll(BARE_URL)) {
    addCandidate(m[0] ?? "", m[0] ?? "");
  }

  return citations;
}

/**
 * `EngineScrapeParser` for the `"perplexity-ui"` scrape engine. PURE,
 * synchronous, dependency-free; never throws; empty/malformed input yields
 * `{ answerText: "", citations: [] }`.
 */
export class PerplexityUiScrapeParser implements EngineScrapeParser {
  parse(raw: RawScrape): ParsedAnswer {
    const markdown = typeof raw?.markdown === "string" ? raw.markdown : "";
    if (markdown.trim().length === 0) return { answerText: "", citations: [] };

    const answerText = stripTrailingSourcesBlock(markdown).trim();
    const citations = extractCitations(markdown);

    return { answerText, citations };
  }
}
