/**
 * ai-visibility-provider.ts — the API-spine seam wiring (in-house-ai-
 * visibility, Sprint 3; arch-20260717-in-house-oss-ai-visibility-
 * architecture.md:42,50-63,67-77,297-314; ADR-3, ADR-5).
 *
 * Mirrors `serp-provider.ts` in shape (a port implementer + a factory
 * function living alongside the seam, `serp-provider.ts:55-64`): composes
 * ONLY viable per-engine `ApiSpineEngineProvider` arms (Sprint 2) into an
 * `AiVisibilityMultiplexer` and hands the result to `selectSource`, which
 * routes it into the LOCKED `AiVisibilityAdapter` (`sources/ai-visibility-
 * adapter.ts`) — the port, the `AiVisibilityRow` shape, and the adapter body
 * are all untouched here (nonGoals).
 *
 * No scrape arm, `CitationVerifier`, scorer, tracked-prompt store,
 * Perplexity mapper, or LLM judge land in this module — those are later
 * sprints (Sprint 4, 7, 8, 10 nonGoals).
 */
import type { BoberConfig } from "../config/schema.js";
import type { SeoEgressGuard } from "./egress.js";
import type { AiVisibilityProvider } from "./sources/ai-visibility-adapter.js";
import type { AiVisibilityRow } from "./data-source.js";
import type { GroundedEngine, GroundedSearchClient } from "../providers/grounded-search.js";
import type { MentionCitationExtractor } from "./sources/mention-citation-extractor.js";
import { ApiSpineEngineProvider } from "./sources/api-spine-provider.js";

/**
 * Injected seam (mirrors the `deps` shape in the architecture doc's
 * `resolveAiVisibilityProvider` section). `makeClient` returns `undefined`
 * when an engine has no usable key/credential — that arm is skipped
 * entirely, never composed (the no-key viability check, ADR-3/ADR-5).
 * Production wiring builds a real `LiveGroundedSearchClient` per keyed
 * engine (`runner.ts`'s `defaultAiVisibilityDeps`); tests inject fakes so
 * this factory — and every caller of it — stays network-free (sc-3-4).
 */
export interface AiVisibilityDeps {
  makeClient: (engine: GroundedEngine) => GroundedSearchClient | undefined;
  extractor: MentionCitationExtractor;
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
 * own beyond the two viability checks below; each returned provider is
 * already fully constructed from already-built dependencies.
 *
 * Returns `undefined` (never an empty-arms multiplexer) when no engine is
 * viable — axis off, `config.seo.aiVisibility` absent, `engines` empty, or
 * every `deps.makeClient` call returns `undefined` (no key). `selectSource`
 * falls back to the offline `LocalExportSource` in that case (no-key-safe,
 * byte-identical-when-off).
 */
export function resolveAiVisibilityProvider(
  config: BoberConfig,
  egress: SeoEgressGuard,
  deps: AiVisibilityDeps,
): AiVisibilityProvider | undefined {
  if (!egress.isAllowed("ai-visibility")) return undefined; // axis off => offline fallback

  const cfg = config.seo?.aiVisibility;
  if (!cfg || cfg.engines.length === 0) return undefined; // nothing configured

  const arms: AiVisibilityProvider[] = [];
  for (const engineCfg of cfg.engines) {
    const client = deps.makeClient(engineCfg.engine);
    if (!client) continue; // no key/credential for this engine => skip (viability check)
    arms.push(new ApiSpineEngineProvider(client, deps.extractor, cfg.samplesPerPrompt, engineCfg.perCallUsd));
  }

  return arms.length > 0 ? new AiVisibilityMultiplexer(arms) : undefined; // no-key-safe
}
