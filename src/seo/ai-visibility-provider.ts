/**
 * ai-visibility-provider.ts — the API-spine seam wiring (in-house-ai-
 * visibility, Sprint 3, widened Sprint 4; arch-20260717-in-house-oss-ai-
 * visibility-architecture.md:42,50-63,67-77,297-314; ADR-3, ADR-5).
 *
 * Mirrors `serp-provider.ts` in shape (a port implementer + a factory
 * function living alongside the seam, `serp-provider.ts:55-64`): composes
 * ONLY viable per-engine `ApiSpineEngineProvider` arms (Sprint 2) into an
 * `AiVisibilityMultiplexer` and hands the result to `selectSource`, which
 * routes it into the LOCKED `AiVisibilityAdapter` (`sources/ai-visibility-
 * adapter.ts`) — the port, the `AiVisibilityRow` shape, and the adapter body
 * are all untouched here (nonGoals).
 *
 * Sprint 4 adds the `CitationVerifier` + `ContentSanitizer` each arm needs
 * (sc-4-3, sc-4-4 D1-Recommended): this is the SOLE production site that
 * constructs `ApiSpineEngineProvider`, and `egress` is already in scope here
 * (a parameter of this function), so a single `DamcrawlerCitationVerifier
 * (egress)` is constructed once and shared across every arm — the verifier
 * self-gates the `site-crawl` axis on every `verify()` call, so sharing one
 * instance across engines is safe (it holds no per-arm state).
 *
 * The `ContentSanitizer` here wraps `defaultGroundedTextSanitizeFn` (below),
 * NOT a damcrawler-backed `sanitize` export. Two reasons: (1) the text this
 * boundary sanitizes — an LLM's grounded `answerText` + its citation urls —
 * is NOT damcrawler-scraped, it comes straight from `GroundedSearchClient
 * .search()`; damcrawler's `sanitize` remains the load-bearing sanitizer for
 * the actual scraped citation BODY, inside `DamcrawlerCitationVerifier`
 * itself, gated by `site-crawl` (`./sources/citation-verifier.ts`). (2)
 * `ContentSanitizer` requires a SYNCHRONOUS `SanitizeFn`
 * (`content-sanitizer.ts:29`), while any damcrawler export can only be
 * reached via an ASYNC lazy `import()` — and this factory is itself
 * synchronous (no `Promise` in its return type), so a damcrawler-backed
 * sanitizer could not be constructed here even behind a gate. This second,
 * always-on boundary is a genuine (not a no-op) layer: it strips recognized
 * prompt-injection role/instruction markers the grounding LLM could echo
 * back from a page it read during its own web search.
 *
 * No scrape arm, scorer, or LLM judge land in this module — those are later
 * sprints (Sprint 8, 10 nonGoals). The Perplexity engine (Sprint 7,
 * `PerplexitySonarClient`, `../providers/grounded-search.js`) composes
 * automatically through the loop below once `deps.makeClient("perplexity")`
 * returns a client — no logic change here was needed.
 */
import type { BoberConfig } from "../config/schema.js";
import type { SeoEgressGuard } from "./egress.js";
import type { AiVisibilityProvider } from "./sources/ai-visibility-adapter.js";
import type { AiVisibilityRow } from "./data-source.js";
import type { GroundedEngine, GroundedSearchClient } from "../providers/grounded-search.js";
import type { MentionCitationExtractor } from "./sources/mention-citation-extractor.js";
import type { ScrapeThrottle } from "./scrape-throttle.js";
import type { ScrapeEngine } from "./sources/scrape-arm-provider.js";
import { ApiSpineEngineProvider } from "./sources/api-spine-provider.js";
import { DamcrawlerCitationVerifier } from "./sources/citation-verifier.js";
import { ContentSanitizer } from "./content-sanitizer.js";
import { ScrapeArmEngineProvider } from "./sources/scrape-arm-provider.js";
import { ChatgptUiScrapeParser } from "./sources/engine-scrape-parser-chatgpt.js";

/**
 * Recognized prompt-injection role/instruction markers — fenced
 * `<system>`/`<|im_start|>`-style tags and "ignore previous instructions"
 * phrasing — the class of payload a grounding LLM could echo back verbatim
 * from a page it read during its own web search. Not damcrawler-grade
 * threat classification (that stays `DamcrawlerCitationVerifier`'s job for
 * scraped citation bodies); this is a narrower, dependency-free, always-on
 * second layer for the LLM's own free-text summary + citation urls.
 */
const GROUNDED_TEXT_INJECTION_PATTERNS: RegExp[] = [
  /<\s*\/?\s*(system|assistant|\|im_start\|?|\|im_end\|?)[^>]*>/gi,
  /\bignore\s+(all\s+|any\s+)?(previous|prior|above)\s+instructions\b/gi,
];

/**
 * Default `SanitizeFn` for `ApiSpineEngineProvider`'s `answerText`/citation-
 * url boundary (sc-4-3). `String.prototype.replace` resets a global
 * pattern's `lastIndex` on every call, so reusing the shared, module-level
 * `RegExp` instances across calls is safe.
 */
export function defaultGroundedTextSanitizeFn(raw: string): { content: string; hadThreats: boolean } {
  let content = raw;
  let hadThreats = false;
  for (const pattern of GROUNDED_TEXT_INJECTION_PATTERNS) {
    const stripped = content.replace(pattern, "");
    if (stripped !== content) hadThreats = true;
    content = stripped;
  }
  return { content: content.trim(), hadThreats };
}

/**
 * Injected seam (mirrors the `deps` shape in the architecture doc's
 * `resolveAiVisibilityProvider` section). `makeClient` returns `undefined`
 * when an engine has no usable key/credential — that arm is skipped
 * entirely, never composed (the no-key viability check, ADR-3/ADR-5).
 * Production wiring builds a real `LiveGroundedSearchClient` per keyed
 * engine (`runner.ts`'s `defaultAiVisibilityDeps`); tests inject fakes so
 * this factory — and every caller of it — stays network-free (sc-3-4).
 *
 * `scrapeThrottle` (Sprint 10) is OPTIONAL — `resolveAiVisibilityProvider`
 * (`../runner.ts:57-58,190-192,392-396` is the SOLE production caller,
 * `defaultAiVisibilityDeps()` builds only `{ makeClient, extractor }`)
 * composes the damcrawler UI-scrape arm ONLY when this dep is present AND
 * the `ai-visibility-scrape` axis is on AND `chatgpt-ui` is configured. A
 * `ScrapeThrottle` needs an absolute ledger path this factory has no
 * `projectRoot` to construct, so it must arrive already-built via this
 * seam — production wiring of a real throttle (`defaultAiVisibilityDeps`
 * constructing one from `config`/`projectRoot`) is a follow-up sprint's
 * work (runner.ts stays byte-identical this sprint, sc-10-5).
 */
export interface AiVisibilityDeps {
  makeClient: (engine: GroundedEngine) => GroundedSearchClient | undefined;
  extractor: MentionCitationExtractor;
  scrapeThrottle?: ScrapeThrottle;
}

/**
 * Fans one `probe()` call out to every configured arm and CONCATENATES
 * their rows — arms are NEVER merged, cross-arm signal is never combined
 * (architecture:44; each row already carries its own `provider` label, so a
 * consumer can always tell which engine produced which observation).
 *
 * `estCostUsdPerPrompt` is the plain sum of each arm's ALREADY N-baked price
 * (`ApiSpineEngineProvider.estCostUsdPerPrompt = perCallUsd * samplesPerPrompt`,
 * Sprint 2, ADR-3) — this class must NOT re-multiply by N.
 */
export class AiVisibilityMultiplexer implements AiVisibilityProvider {
  readonly name = "ai-visibility-multiplexer";
  readonly estCostUsdPerPrompt: number;

  constructor(private readonly arms: AiVisibilityProvider[]) {
    this.estCostUsdPerPrompt = arms.reduce((sum, arm) => sum + arm.estCostUsdPerPrompt, 0);
  }

  /**
   * One arm rejecting => its rows are simply omitted, the other arms still
   * emit (architecture:277). If EVERY arm rejects (and there is at least one
   * arm), rethrow instead of resolving `[]` — the LOCKED `AiVisibilityAdapter`
   * converts any probe throw into `abstain` + books nothing
   * (`ai-visibility-adapter.ts:141-143`), which is exactly the "all fail =>
   * abstain, nothing booked" invariant `ApiSpineEngineProvider.probe` already
   * upholds one level down (sc-2-4). Resolving `[]` here instead would let
   * the adapter book USD for zero rows on a total outage — the rethrow keeps
   * that impossible.
   */
  async probe(target: string, prompts: string[], locale?: string): Promise<AiVisibilityRow[]> {
    // The `async` wrapper (not a bare `.map((arm) => arm.probe(...))`) matters:
    // it captures a SYNCHRONOUS throw from a misbehaving arm as a rejected
    // promise too, so `Promise.allSettled` never has an exception escape past
    // it before every arm has had a chance to run.
    const settled = await Promise.allSettled(
      this.arms.map(async (arm) => arm.probe(target, prompts, locale)),
    );
    const fulfilled = settled.filter(
      (s): s is PromiseFulfilledResult<AiVisibilityRow[]> => s.status === "fulfilled",
    );
    if (this.arms.length > 0 && fulfilled.length === 0) {
      throw new Error("AiVisibilityMultiplexer: every arm failed");
    }
    return fulfilled.flatMap((s) => s.value);
  }
}

/**
 * Select which per-engine arms are viable and compose them into an
 * `AiVisibilityMultiplexer` — mirrors `resolveSerpProvider`
 * (`serp-provider.ts:55-64`) in DI style: this factory does NO gating of its
 * own beyond the viability checks below; each returned provider is already
 * fully constructed from already-built dependencies. The API spine and the
 * scrape arm (Sprint 10) land in the SAME `arms` array and share the ONE
 * multiplexer — they stay unmixable because each row carries its own
 * `provider` label (sc-10-4; `AiVisibilityMultiplexer` never merges rows).
 *
 * An arm is added when EITHER:
 *   (a) the `ai-visibility` axis is on AND a configured engine is keyed
 *       (`deps.makeClient` returns a client) — the existing API-spine loop, or
 *   (b) the `ai-visibility-scrape` axis is on AND `cfg.scrape?.engines`
 *       includes `"chatgpt-ui"` AND `deps.scrapeThrottle` is provided (the
 *       scrape arm needs an already-built throttle, see `AiVisibilityDeps`
 *       docstring).
 * Both API and scrape arms reuse the SAME shared `DamcrawlerCitationVerifier`
 * (self-gates `site-crawl` per call, holds no per-arm state — safe to share).
 *
 * Returns `undefined` (never an empty-arms multiplexer) when NEITHER axis is
 * on, `config.seo.aiVisibility` is absent, or no arm ends up viable (no key /
 * no scrape engine configured / no throttle dep). `selectSource` falls back
 * to the offline `LocalExportSource` in that case (no-key-safe,
 * byte-identical-when-off).
 */
export function resolveAiVisibilityProvider(
  config: BoberConfig,
  egress: SeoEgressGuard,
  deps: AiVisibilityDeps,
): AiVisibilityProvider | undefined {
  const cfg = config.seo?.aiVisibility;
  if (!cfg) return undefined; // nothing configured at all

  const apiAxisOn = egress.isAllowed("ai-visibility");
  const scrapeAxisOn = egress.isAllowed("ai-visibility-scrape");
  if (!apiAxisOn && !scrapeAxisOn) return undefined; // both axes off => offline fallback

  // Shared across every arm (Sprint 4, extended Sprint 10): the verifier
  // self-gates `site-crawl` on every `verify()` call and holds no per-arm
  // state; the sanitizer's `SanitizeFn` is a pure function — both are safe
  // to share across API arms (the scrape arm builds its OWN sanitizer from
  // the loaded damcrawler module, not this one — see `ScrapeArmEngineProvider`).
  const verifier = new DamcrawlerCitationVerifier(egress);
  const sanitizer = new ContentSanitizer(defaultGroundedTextSanitizeFn);

  const arms: AiVisibilityProvider[] = [];

  if (apiAxisOn) {
    for (const engineCfg of cfg.engines) {
      const client = deps.makeClient(engineCfg.engine);
      if (!client) continue; // no key/credential for this engine => skip (viability check)
      arms.push(
        new ApiSpineEngineProvider(
          client,
          deps.extractor,
          cfg.samplesPerPrompt,
          engineCfg.perCallUsd,
          verifier,
          sanitizer,
        ),
      );
    }
  }

  if (scrapeAxisOn && deps.scrapeThrottle && cfg.scrape?.engines.includes("chatgpt-ui" satisfies ScrapeEngine)) {
    const scrapeCfg = cfg.scrape;
    arms.push(
      new ScrapeArmEngineProvider(
        egress,
        "chatgpt-ui",
        new ChatgptUiScrapeParser(),
        deps.extractor,
        verifier,
        deps.scrapeThrottle,
        cfg.samplesPerPrompt,
        scrapeCfg.authSession,
        scrapeCfg.proxyUsdPerScrape,
        scrapeCfg.proxy,
      ),
    );
  }

  return arms.length > 0 ? new AiVisibilityMultiplexer(arms) : undefined; // no-key-safe / no-throttle-safe
}
