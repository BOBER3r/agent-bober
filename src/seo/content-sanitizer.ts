/**
 * ContentSanitizer — fail-closed wrapper around damcrawler's `sanitize`
 * (spec-20260717-seo-improver-builder, Sprint 6; ADR-11).
 *
 * ADR-11's decision is to sanitize untrusted crawled/scraped free-text
 * INSIDE the damcrawler adapter, at the network→in-process boundary,
 * BEFORE it ever reaches `SeoAnalyzer` (which `JSON.stringify`s rows
 * verbatim into its LLM system prompt — the prompt-injection surface this
 * sprint closes). This class does no importing/loading of damcrawler
 * itself — the caller (`DamcrawlerCrawlEngine`, already holding the loaded
 * module behind the `site-crawl` axis) injects the narrow `SanitizeFn`.
 *
 * IMPORTANT SDK correction (see sprint briefing §0/§9.1): damcrawler's
 * `sanitizeWithReport(raw, sourceUrl?)` returns a bare `string` — it does
 * NOT yield `hadThreats`. The only damcrawler export exposing `hadThreats`
 * is `sanitize(raw, options?): { content; threats; hadThreats }`
 * (`damcrawler/src/lib/sanitize.ts:68-79,89`). This wrapper's `SanitizeFn`
 * type matches THAT signature — callers must inject `dam.sanitize`, not
 * `dam.sanitizeWithReport`.
 */
import { logger, type Logger } from "../utils/logger.js";

/**
 * The narrow sanitize surface this module depends on — a SUBSET of
 * damcrawler's `SanitizeResult` (`sanitize.ts:68-79`, `threats` omitted,
 * this module never needs the detailed threat breakdown). Injected so
 * tests never require the real `damcrawler` dependency.
 */
export type SanitizeFn = (raw: string, options?: { sourceUrl?: string }) => { content: string; hadThreats: boolean };

/**
 * Fail-closed content sanitizer. `clean()` never throws: a successful
 * sanitize call logs+strips on `hadThreats`; a sanitize-function error
 * drops the text entirely (`content: ""`, `hadThreats: true`) rather than
 * letting raw, unsanitized attacker-controlled text pass through.
 */
export class ContentSanitizer {
  constructor(
    private readonly sanitizeFn: SanitizeFn,
    private readonly log: Pick<Logger, "warn"> = logger,
  ) {}

  /**
   * Sanitizes `text` sourced from `url`. `hadThreats` is logged (warn, for
   * audit) and the STRIPPED `content` is returned either way — callers
   * must never fall back to the raw input. A thrown sanitize error is
   * treated as fail-closed: the page's free-text is dropped rather than
   * passed through unsanitized.
   */
  clean(text: string, url: string): { content: string; hadThreats: boolean } {
    try {
      const r = this.sanitizeFn(text, { sourceUrl: url });
      if (r.hadThreats) {
        this.log.warn(`[seo][content-sanitizer] injection vectors neutralized in ${url}`);
      }
      return { content: r.content, hadThreats: r.hadThreats };
    } catch {
      return { content: "", hadThreats: true }; // fail-closed DROP: never pass raw text through
    }
  }
}
