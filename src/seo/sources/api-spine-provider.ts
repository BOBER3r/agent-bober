/**
 * ApiSpineEngineProvider — one grounded-search engine's `AiVisibilityProvider`
 * (in-house-ai-visibility, Sprint 2;
 * arch-20260717-in-house-oss-ai-visibility-architecture.md:44,84-97,278).
 *
 * Mirrors `DamcrawlerSerpProvider`'s injected-deps + `readonly name`/
 * `readonly estCost...` shape (`./damcrawler-serp-provider.ts:69-101`), but
 * the injected transport is a Sprint-1 `GroundedSearchClient` (not
 * damcrawler) and there is no egress gate or sanitizer here — those are the
 * ADAPTER's job (`./ai-visibility-adapter.ts`), which is NOT wired to this
 * class this sprint (nonGoal: no seam/factory/multiplexer wiring, Sprint 3).
 *
 * `probe()` runs `samplesPerPrompt` (N) independent grounded-search samples
 * per prompt and emits ONE raw `AiVisibilityRow` per real observation —
 * never a pre-aggregate ("Every arm emits raw per-(prompt,provider,sample)
 * AiVisibilityRows ... so API and scrape signal are structurally
 * unmixable", architecture:44). Each row is stamped with `this.name`
 * (`= client.engine`), so a future multiplexer can tell which engine
 * produced which observation without any additional bookkeeping.
 *
 * Cost accounting (ADR-3, `arch-20260717-in-house-oss-ai-visibility-adr-3.md`):
 * the LOCKED `AiVisibilityAdapter` books `estCostUsdPerPrompt * prompts.length`
 * (`ai-visibility-adapter.ts:114`) — it has no notion of N. So N MUST be
 * baked into `estCostUsdPerPrompt` here: `estCostUsdPerPrompt = perCallUsd *
 * samplesPerPrompt`. Getting this wrong under-books the USD ceiling.
 *
 * Sample-failure contract (sc-2-4, architecture:278 "Sample throws =>
 * dropped (wider CI); all fail => abstain, nothing booked"): a single
 * rejecting sample is caught and `continue`d — it never throws out of the
 * loop, is never mislabeled, and never fabricates a citation. If EVERY
 * attempted sample across every prompt rejects, `probe()` throws instead of
 * returning `[]` — the (not-yet-wired) adapter converts any probe throw
 * into `abstain` + books nothing (`ai-visibility-adapter.ts:141-143`), which
 * is exactly the "all fail => abstain, nothing booked" outcome. Calling
 * `probe()` with zero prompts or `samplesPerPrompt <= 0` attempts nothing
 * and returns `[]` without throwing (there is no failure to report).
 */
import type { AiVisibilityProvider } from "./ai-visibility-adapter.js";
import type { AiVisibilityRow } from "../data-source.js";
import type { GroundedAnswer, GroundedEngine, GroundedSearchClient } from "../../providers/grounded-search.js";
import type { MentionCitationExtractor } from "./mention-citation-extractor.js";

export class ApiSpineEngineProvider implements AiVisibilityProvider {
  readonly name: GroundedEngine;
  readonly estCostUsdPerPrompt: number;

  constructor(
    private readonly client: GroundedSearchClient,
    private readonly extractor: MentionCitationExtractor,
    private readonly samplesPerPrompt: number,
    perCallUsd: number,
  ) {
    this.name = client.engine; // every row is stamped with the injected client's engine
    this.estCostUsdPerPrompt = perCallUsd * samplesPerPrompt; // ADR-3: N baked in, once, from the SAME N used below
  }

  async probe(target: string, prompts: string[], locale?: string): Promise<AiVisibilityRow[]> {
    const rows: AiVisibilityRow[] = [];
    let attempted = 0;

    for (const prompt of prompts) {
      for (let i = 0; i < this.samplesPerPrompt; i++) {
        attempted += 1;
        let answer: GroundedAnswer;
        try {
          answer = await this.client.search(prompt, locale);
        } catch {
          continue; // sc-2-4: drop the failed sample — never throw, never mislabel, never merge
        }

        const obs = this.extractor.extract({ target, answerText: answer.answerText, citations: answer.citations });
        const row: AiVisibilityRow = {
          prompt,
          provider: this.name,
          mentioned: obs.mentioned,
          citationPresent: obs.citationPresent,
          sourceUrls: obs.sourceUrls,
        };
        if (obs.rank !== undefined) row.rank = obs.rank; // optional-key omission — never `rank: undefined`
        rows.push(row);
      }
    }

    // Every attempted sample rejected (and at least one was attempted): throw
    // so the caller (a future adapter) can degrade to abstain + book nothing,
    // rather than silently returning an empty-but-successful `[]`.
    if (attempted > 0 && rows.length === 0) {
      throw new Error("ApiSpineEngineProvider: every sample rejected");
    }

    return rows;
  }
}
