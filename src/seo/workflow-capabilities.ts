/**
 * WORKFLOW_CAPABILITIES — per-workflow capability-subset map
 * (spec-20260717-seo-improver-builder, Sprint 9; ADR-7).
 *
 * `gatherDataBundle` (`./runner.ts`) probes ONLY the capabilities listed for
 * the running workflow, so the metered `ai-visibility` capability is fetched
 * ONLY for workflows that actually consume it. An omitted capability leaves
 * its `SeoDataBundle` arm `undefined`, which the analyzer already renders as
 * "not requested" (`analyzer.ts:127-128`) — no analyzer change is needed for
 * omission itself.
 *
 * `CORE` is the original five capabilities gathered before this sprint
 * (`search-analytics`, `url-inspection`, `serp`, `keywords`, `backlinks`).
 * Every pre-existing workflow keeps exactly `CORE` so the byte-identical
 * offline golden report (sc-9-5) is unaffected — adding/removing a CORE
 * capability for an existing workflow would change `dataProvenance` and
 * break the deep-equal (see the sprint briefing §11 Pitfall 1).
 *
 * `SeoWorkflow` is a closed 8-member union (`types.ts:17-25`) — this is an
 * EXHAUSTIVE `Record<SeoWorkflow, SeoCapability[]>` (not `Partial`), so a
 * missing workflow key is a compile error, not a silent gap (Pitfall 6).
 */
import type { SeoWorkflow } from "./types.js";
import type { SeoCapability } from "./data-source.js";

const CORE: SeoCapability[] = ["search-analytics", "url-inspection", "serp", "keywords", "backlinks"];

export const WORKFLOW_CAPABILITIES: Record<SeoWorkflow, SeoCapability[]> = {
  "technical-audit": CORE, // MUST NOT include "ai-visibility" (sc-9-4 / stopCondition)
  "rank-track": CORE,
  "content-decay": CORE,
  "topical-map": CORE,
  "ai-visibility": [...CORE, "ai-visibility"], // MUST include "ai-visibility"
  "parasite-watch": [...CORE, "ai-visibility"], // AI-answer surfaces are relevant to parasite/answer-engine watch
  "internal-linking": [...CORE, "link-graph"], // link-graph consumer
  "schema-audit": CORE,
};
