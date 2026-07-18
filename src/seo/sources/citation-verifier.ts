/**
 * DamcrawlerCitationVerifier — verifies each already-cited URL is live and
 * carries the target brand, via a gated damcrawler scrape (in-house-ai-
 * visibility, Sprint 4;
 * arch-20260717-in-house-oss-ai-visibility-architecture.md:163-174,253,283).
 *
 * Mirrors `DamcrawlerSerpProvider`'s guard-first/lazy-load/never-throw shape
 * (`./damcrawler-serp-provider.ts:69-106`) with two differences: the network
 * call is a per-URL `scrape()` (not `search()`), and there is a THIRD guard
 * — `assertSafeUrl` per url, AFTER `load()`, BEFORE any damcrawler network
 * call — mirroring `DamcrawlerCrawlEngine`'s SSRF guard (F2,
 * `./damcrawler-crawl-engine.ts:156,191-192,227`). This class only fetches
 * URLs a `MentionCitationExtractor` already surfaced as candidates — it does
 * NOT scrape answer-engine UIs (that is `ScrapeArmEngineProvider`, Sprint
 * 10, a nonGoal here).
 *
 * `verify()` is fail-closed on every axis (sc-4-2): axis off, damcrawler
 * absent, a per-url SSRF rejection, or a scrape error/`.error` result all
 * degrade that url to `{ live: false, brandOnPage: false }` — this class
 * NEVER fabricates a live citation and NEVER throws to its caller. It
 * returns exactly one `VerifiedCitation` per input url, in input order.
 *
 * damcrawler's `ScrapeResult` (confirmed against
 * `/Users/bober4ik/damcrawler/src/commands/scrape.ts:99-125`) exposes NO
 * numeric HTTP status field — the batch-mode `error?` string is the only
 * failure signal, so `live` here means "scrape succeeded without an
 * `.error`", not literally "returned HTTP 200".
 *
 * Per ADR-11, the scraped `title`/`markdown` are attacker-controlled
 * free-text and are sanitized HERE, at the network->in-process boundary,
 * via `ContentSanitizer(dam.sanitize)` — mirrors every other damcrawler
 * adapter (`damcrawler-crawl-engine.ts`, `damcrawler-serp-provider.ts`).
 * `brandOnPage` is computed over the SANITIZED body only.
 */
import type { SeoEgressGuard } from "../egress.js";
import { ContentSanitizer } from "../content-sanitizer.js";

/** One verified (or fail-closed-unverified) citation URL. */
export type VerifiedCitation = { url: string; live: boolean; brandOnPage: boolean };

export interface CitationVerifier {
  verify(target: string, urls: string[]): Promise<VerifiedCitation[]>;
}

/**
 * NARROW local view of the ONLY damcrawler surface this verifier calls —
 * confirmed against the real damcrawler source (sprint briefing §1):
 *   - `scrape(urls, options)` — `damcrawler/src/commands/scrape.ts:99-125`;
 *     batch-mode result rows carry `{url, title, markdown, error?}`; there is
 *     NO numeric HTTP status field, `error?` is the only failure signal.
 *   - `sanitize(raw, options?)` — the ONLY damcrawler sanitize export that
 *     yields `hadThreats` (`damcrawler/src/lib/sanitize.ts:68-79,89`);
 *     `sanitizeWithReport` returns a bare `string` and must NOT be used
 *     here (mirrors every other damcrawler adapter in this directory).
 *   - `assertSafeUrl(urlString)` — damcrawler's own SSRF guard
 *     (`damcrawler/src/index.ts:259`), called per url AFTER `load()`,
 *     BEFORE any damcrawler network call (F2, mirrors
 *     `damcrawler-crawl-engine.ts:156,191-192,227`).
 * Defined locally (not imported from the real dep) so tests never need the
 * real `damcrawler` package installed.
 */
interface DamcrawlerVerifyModule {
  scrape(
    urls: string[],
    options: { formats?: string[] },
  ): Promise<Array<{ url: string; title: string; markdown: string; error?: string }>>;
  sanitize(raw: string, options?: { sourceUrl?: string }): { content: string; hadThreats: boolean };
  assertSafeUrl(urlString: string): Promise<void>;
}

/** Loader seam — the default performs the lazy dynamic import; tests inject a FAKE module (or `undefined` to simulate the dep being absent). */
export type DamcrawlerVerifyLoader = () => Promise<DamcrawlerVerifyModule | undefined>;

const defaultLoader: DamcrawlerVerifyLoader = async () => {
  // Indirection through a variable: under `moduleResolution: NodeNext` a
  // LITERAL `import("damcrawler")` is statically resolved by tsc and fails
  // with TS2307 when the dep is absent. Routing the specifier through a
  // `string` variable makes tsc treat the result as `any`, so `tsc --noEmit`
  // stays clean whether or not damcrawler is installed (mirrors
  // `damcrawler-crawl-engine.ts:111-120`, `damcrawler-serp-provider.ts:54-63`).
  const mod = "damcrawler";
  return (await import(mod).catch(() => undefined)) as DamcrawlerVerifyModule | undefined;
};

// ── Host/brand matching — mirrors mention-citation-extractor.ts:55-95 ────
// No shared URL/host util exists in `src` (that file's docstring, :16-18);
// these tiny helpers are duplicated deliberately rather than reaching across
// module boundaries for a private implementation detail.

/** `try { new URL(candidate).hostname } catch { "" }` — URL parsing must never throw here. Accepts a full URL or a bare domain. */
function safeHost(raw: string): string {
  if (typeof raw !== "string" || raw.trim().length === 0) return "";
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
  const candidate = hasScheme ? raw : `https://${raw}`;
  try {
    return new URL(candidate).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Strips a leading `www.` label. */
function stripWww(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

/** Bare, `www.`-stripped host for `raw` — `""` when `raw` is empty/malformed. */
function bareHost(raw: string): string {
  return stripWww(safeHost(raw));
}

/** The host's first label — the brand token (e.g. `"target"` from `"target.example"`). */
function brandToken(host: string): string {
  const [first] = host.split(".");
  return first ?? "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive, word-boundary substring test (avoids `"ace"` matching inside `"space"`). */
function containsWordBoundary(haystack: string, needle: string): boolean {
  if (!needle) return false;
  const pattern = new RegExp(`\\b${escapeRegExp(needle)}\\b`, "i");
  return pattern.test(haystack);
}

/**
 * `CitationVerifier` backed by damcrawler. Guard-first, lazy-load, per-url
 * SSRF-guarded, sanitize-at-boundary, never-throw; returns exactly one
 * `VerifiedCitation` per input url, in order.
 */
export class DamcrawlerCitationVerifier implements CitationVerifier {
  constructor(
    private readonly egress: SeoEgressGuard,
    private readonly load: DamcrawlerVerifyLoader = defaultLoader,
  ) {}

  async verify(target: string, urls: string[]): Promise<VerifiedCitation[]> {
    const unverified = (): VerifiedCitation[] => urls.map((url) => ({ url, live: false, brandOnPage: false }));

    // -- STATEMENT 1: egress gate — FIRST, before any import (sc-4-2) --
    try {
      this.egress.assertAllowed("site-crawl");
    } catch {
      return unverified();
    }

    const dam = await this.load();
    if (!dam) return unverified(); // damcrawler-not-installed (optional peer dep)

    const brand = brandToken(bareHost(target));
    const sanitizer = new ContentSanitizer(dam.sanitize); // ADR-11: sanitize at the network->in-process boundary

    const results = await Promise.all(urls.map((url) => this.verifyOne(dam, sanitizer, brand, url)));
    return results;
  }

  /** Verifies a single url: SSRF guard, then scrape+sanitize+brand-match. Never throws — fail-closed on any error. */
  private async verifyOne(
    dam: DamcrawlerVerifyModule,
    sanitizer: ContentSanitizer,
    brand: string,
    url: string,
  ): Promise<VerifiedCitation> {
    try {
      await dam.assertSafeUrl(url); // F2-style guard, AFTER load(), BEFORE any damcrawler network call
    } catch {
      return { url, live: false, brandOnPage: false };
    }

    try {
      const [result] = await dam.scrape([url], { formats: ["markdown"] });
      // Missing result row or a batch-mode `.error` — damcrawler's ScrapeResult
      // has no numeric HTTP status; `error?` is the only failure signal.
      if (!result || result.error) {
        return { url, live: false, brandOnPage: false };
      }

      const title = sanitizer.clean(result.title, url).content;
      const body = sanitizer.clean(result.markdown, url).content;
      const brandOnPage = containsWordBoundary(body, brand) || containsWordBoundary(title, brand);

      return { url, live: true, brandOnPage };
    } catch {
      return { url, live: false, brandOnPage: false }; // scrape threw — fail-closed
    }
  }
}
