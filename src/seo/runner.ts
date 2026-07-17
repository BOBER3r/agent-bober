/**
 * SeoWorkflowRunner — the end-to-end SEO workflow pipeline
 * (spec-20260715-ultimate-seo-suite, Sprint 11). Mirrors
 * `runStandaloneSecurityAudit` (`src/cli/commands/security-audit.ts:141-180`):
 * resolve playbook context -> select a data source -> gather data -> analyze
 * -> never-encode filter -> citation gate -> persist -> best-effort hub emit
 * -> exit code.
 *
 * Clock discipline: `now` is injected by the caller (`SeoCommand`) and NEVER
 * re-stamped here — this file never constructs a `Date` for wall-clock
 * purposes (the `.tmp` uniqueness suffix inside `SeoReportStore.save` is a
 * uniqueness token, not a report timestamp, and lives in a different file).
 *
 * Fail-closed: EVERY step that can throw (context resolution, source
 * selection, data gathering, analysis, persistence) is wrapped in a single
 * top-level try/catch -> `exitCode: 2` (arch line 395). A transport error
 * from `analyzer.analyze` (which does NOT catch `llm.chat` errors itself,
 * `analyzer.ts:16-18`) is caught here. A `parsed: false` analysis result is
 * ALSO fail-closed -> `exitCode: 2` with ZERO hub emits (sc-11-5) — checked
 * BEFORE the never-encode filter and citation gate run.
 *
 * Never-encode belt (spec-20260717-seo-improver-builder, Sprint 2; ADR-3):
 * `NeverEncodeFilter` runs between the `parsed` check and the citation gate,
 * dropping any LLM-synthesized banned tactic — even one carrying a
 * well-formed `citationUrl` that would otherwise pass the gate. Only its
 * `kept` findings ever reach `SeoCitationGate.apply`.
 *
 * Hub emission is best-effort and happens strictly AFTER the report has
 * been persisted; a hub failure never changes the exit code (mirrors
 * `emitFindingsToHub`, `security-audit.ts:196-239`). Only `gate.cited`
 * findings are ever passed to the emitter — an uncited finding is dropped
 * TWICE (the gate, then `SeoHubEmitter.mapToFindings`'s own belt-and-
 * suspenders check).
 */
import type { BoberConfig } from "../config/schema.js";
import { createClient } from "../providers/factory.js";
import { FactStore, factsDbPath, ensureFactsDir } from "../state/facts.js";
import { ingestFinding } from "../hub/finding-store.js";
import { logger } from "../utils/logger.js";

import type { SeoWorkflow, SeoReport, DataOutcome } from "./types.js";
import { SeoPlaybookIndex } from "./playbook-index.js";
import { SeoPlaybookRetriever } from "./retriever.js";
import { SeoEgressGuard } from "./egress.js";
import { SeoQuotaGovernor } from "./quota-governor.js";
import { LocalExportSource } from "./sources/local-export.js";
import { GscAdapter } from "./sources/gsc-adapter.js";
import { DataForSeoAdapter } from "./sources/dataforseo-adapter.js";
import { CrawlSource } from "./sources/crawl-source.js";
import { DamcrawlerCrawlEngine } from "./sources/damcrawler-crawl-engine.js";
import { ContentSanitizer } from "./content-sanitizer.js";
import { resolveSerpProvider } from "./serp-provider.js";
import type { SerpProvider } from "./serp-provider.js";
import { WORKFLOW_CAPABILITIES } from "./workflow-capabilities.js";
import type {
  SeoDataSource,
  SeoCapability,
  SearchAnalyticsQuery,
  SearchAnalyticsRow,
  UrlInspectionQuery,
  UrlInspectionRow,
  SerpQuery,
  SerpRow,
  KeywordQuery,
  KeywordRow,
  BacklinkQuery,
  BacklinkRow,
  AiVisibilityQuery,
  AiVisibilityRow,
  LinkGraphQuery,
  LinkGraphRow,
} from "./data-source.js";
import { SeoAnalyzer } from "./analyzer.js";
import type { SeoAnalysis, SeoDataBundle } from "./analyzer.js";
import { SeoCitationGate } from "./citation-gate.js";
import { NeverEncodeFilter } from "./never-encode-filter.js";
import { SeoReportStore, deriveReportId } from "./report-store.js";
import { SeoHubEmitter } from "./hub-emitter.js";
import type { SeoFindingSink } from "./hub-emitter.js";
import { SeoRecommendationVerifier } from "./verifier.js";
import type { SeoVerifier } from "./verifier.js";

// ── Public types (arch lines 61-89) ─────────────────────────────────────

export type SeoRunInput = {
  projectRoot: string;
  /** May omit `seo` entirely — the explicit CLI call IS the opt-in. */
  config: BoberConfig;
  workflow: SeoWorkflow;
  /** Defaults to `config.seo?.defaultTarget`, then `DEFAULT_TARGET_FALLBACK`. */
  target?: string;
  /** ISO timestamp, stamped ONCE by `SeoCommand`. */
  now: string;
  /** TEST injection — default = `selectSource(config, projectRoot)`. */
  dataSource?: SeoDataSource;
  /** TEST injection — default binds `ingestFinding` to a real `FactStore`. */
  findingSink?: SeoFindingSink;
  /**
   * TEST injection so `runner.test.ts` never builds a real LLM client
   * (the built `SeoAnalyzer` is LLM-only — `analyzer.ts:280-288` always
   * calls `llm.chat`). Default = a real `SeoAnalyzer` via `createClient`.
   */
  analyzer?: SeoAnalyzer;
  /**
   * TEST injection for the opt-in adversarial verifier stage (Sprint 12).
   * Default = a real `SeoRecommendationVerifier`, constructed and invoked
   * ONLY when `config.seo?.verifier?.enabled === true` (byte-identical to
   * the no-verifier run otherwise — sc-12-2).
   */
  verifier?: SeoVerifier;
};

export type SeoRunOutcome = { report?: SeoReport; exitCode: 0 | 2 };

// ── Defaults ─────────────────────────────────────────────────────────

const DEFAULT_TARGET_FALLBACK = "unspecified-target";

/**
 * bober: `config.seo` has no `model` field — this is the sole model the
 *        runner defaults to for the analyzer's LLM client. Add
 *        `config.seo.model` if per-project model choice is ever needed.
 */
const DEFAULT_SEO_MODEL = "sonnet";

function buildDefaultAnalyzer(): SeoAnalyzer {
  // createClient is the ONLY place SDKs are imported. BOBER_TEST_DETERMINISTIC=1
  // makes this an inert stub client, but tests should still inject a scripted
  // analyzer (via input.analyzer) so a real network call is never even attempted.
  const client = createClient(undefined, null, undefined, DEFAULT_SEO_MODEL, "seo");
  return new SeoAnalyzer(client, DEFAULT_SEO_MODEL);
}

// ── selectSource + CapabilitySeoRouter (sc-9-1, sc-9-2, sc-9-3) ─────────

function quotaLedgerPath(projectRoot: string): string {
  return `${projectRoot}/.bober/seo/quota-ledger.json`;
}

/**
 * Shared "unrouted" stub — every method resolves `{ kind: "disabled" }`
 * regardless of which capability method is invoked. `CapabilitySeoRouter`
 * dispatches to this for any capability key absent from its `routes` map.
 */
const DISABLED_SOURCE: SeoDataSource = {
  capabilities: () => [],
  searchAnalytics: async () => ({ kind: "disabled" }),
  urlInspection: async () => ({ kind: "disabled" }),
  serp: async () => ({ kind: "disabled" }),
  keywords: async () => ({ kind: "disabled" }),
  backlinks: async () => ({ kind: "disabled" }),
  aiVisibility: async () => ({ kind: "disabled" }),
  linkGraph: async () => ({ kind: "disabled" }),
};

/**
 * CapabilitySeoRouter — dispatches each `SeoDataSource` capability method to
 * the ONE source that owns that capability key (spec-20260717-seo-improver-
 * builder, Sprint 9; replaces `CompositeSeoSource`). Assembled by
 * `selectSource` per the ADR-8/ADR-10 route table (sc-9-3). An unrouted
 * capability (absent from `routes`) resolves `{ kind: "disabled" }` via
 * `DISABLED_SOURCE` — the router itself never throws (sc-9-1).
 */
class CapabilitySeoRouter implements SeoDataSource {
  constructor(private readonly routes: Partial<Record<SeoCapability, SeoDataSource>>) {}

  /**
   * `Object.keys(routes)`, NOT a union of each routed source's OWN
   * `capabilities()` — a routed source may itself advertise capabilities
   * this router does not route to it (sprint briefing §11 Pitfall 8).
   */
  capabilities(): SeoCapability[] {
    return Object.keys(this.routes) as SeoCapability[];
  }
  searchAnalytics(q: SearchAnalyticsQuery): Promise<DataOutcome<SearchAnalyticsRow[]>> {
    return (this.routes["search-analytics"] ?? DISABLED_SOURCE).searchAnalytics(q);
  }
  urlInspection(q: UrlInspectionQuery): Promise<DataOutcome<UrlInspectionRow[]>> {
    return (this.routes["url-inspection"] ?? DISABLED_SOURCE).urlInspection(q);
  }
  serp(q: SerpQuery): Promise<DataOutcome<SerpRow[]>> {
    return (this.routes["serp"] ?? DISABLED_SOURCE).serp(q);
  }
  keywords(q: KeywordQuery): Promise<DataOutcome<KeywordRow[]>> {
    return (this.routes["keywords"] ?? DISABLED_SOURCE).keywords(q);
  }
  backlinks(q: BacklinkQuery): Promise<DataOutcome<BacklinkRow[]>> {
    return (this.routes["backlinks"] ?? DISABLED_SOURCE).backlinks(q);
  }
  aiVisibility(q: AiVisibilityQuery): Promise<DataOutcome<AiVisibilityRow[]>> {
    return (this.routes["ai-visibility"] ?? DISABLED_SOURCE).aiVisibility(q);
  }
  linkGraph(q: LinkGraphQuery): Promise<DataOutcome<LinkGraphRow[]>> {
    return (this.routes["link-graph"] ?? DISABLED_SOURCE).linkGraph(q);
  }
}

/**
 * SerpProviderSource — adapts a `SerpProvider` port's `serp(keyword,
 * location)` (`serp-provider.ts:36-45`) into this file's `SeoDataSource`
 * seam, whose `serp` method takes a single `SerpQuery` (sprint briefing
 * Pattern C). Serves ONLY `serp`; every other capability is
 * `{ kind: "disabled" }` unconditionally. `q.priority` is dropped by this
 * shim — byte-identical, because `DataForSeoAdapter.serp` already defaults
 * an absent `priority` to `"standard"` (`dataforseo-adapter.ts:199`).
 */
class SerpProviderSource implements SeoDataSource {
  constructor(private readonly provider: SerpProvider) {}

  capabilities(): SeoCapability[] {
    return ["serp"];
  }
  serp(q: SerpQuery): Promise<DataOutcome<SerpRow[]>> {
    return this.provider.serp(q.keyword, q.location);
  }
  async searchAnalytics(_q: SearchAnalyticsQuery): Promise<DataOutcome<SearchAnalyticsRow[]>> {
    return { kind: "disabled" };
  }
  async urlInspection(_q: UrlInspectionQuery): Promise<DataOutcome<UrlInspectionRow[]>> {
    return { kind: "disabled" };
  }
  async keywords(_q: KeywordQuery): Promise<DataOutcome<KeywordRow[]>> {
    return { kind: "disabled" };
  }
  async backlinks(_q: BacklinkQuery): Promise<DataOutcome<BacklinkRow[]>> {
    return { kind: "disabled" };
  }
  async aiVisibility(_q: AiVisibilityQuery): Promise<DataOutcome<AiVisibilityRow[]>> {
    return { kind: "disabled" };
  }
  async linkGraph(_q: LinkGraphQuery): Promise<DataOutcome<LinkGraphRow[]>> {
    return { kind: "disabled" };
  }
}

/**
 * Build the `SeoDataSource` for a run from the FOUR independent egress axes
 * (widened from two, spec-20260717-seo-improver-builder Sprint 9). ALL FOUR
 * axes off (default) -> `LocalExportSource` (zero egress, no credentials
 * touched, no governor/ledger constructed, `import('damcrawler')` never
 * evaluated — sc-9-2). This `return` is the FIRST statement after the
 * predicate, strictly BEFORE `SeoQuotaGovernor.load` (sprint briefing
 * Pattern B / Pitfall 2) — that ordering is what makes the all-off path
 * provably zero-construction.
 *
 * Otherwise, assemble a `CapabilitySeoRouter` per the deterministic
 * ADR-8/ADR-10 route table (sc-9-3):
 *   - `url-inspection`: `GscAdapter` when `search-console` is on (GSC always
 *     wins, ADR-8); else `CrawlSource` when `site-crawl` is on.
 *   - `link-graph`: `CrawlSource` when `site-crawl` is on.
 *   - `serp`: the config-selected `SerpProvider` (`resolveSerpProvider`,
 *     ADR-10), wrapped in `SerpProviderSource`, whenever `serp-provider` OR
 *     `site-crawl` is on (whichever axis the selected provider itself
 *     requires; each provider re-asserts its own axis on call).
 *   - `keywords`/`backlinks`: `DataForSeoAdapter` when `serp-provider` is on.
 *   - `ai-visibility`: `LocalExportSource` (the offline arm) when
 *     `ai-visibility` is on — see the OPEN DESIGN DECISION note below.
 */
export async function selectSource(config: BoberConfig, projectRoot: string): Promise<SeoDataSource> {
  const egress = SeoEgressGuard.fromConfig(config);
  const searchConsoleAllowed = egress.isAllowed("search-console");
  const serpProviderAllowed = egress.isAllowed("serp-provider");
  const aiVisibilityAllowed = egress.isAllowed("ai-visibility");
  const siteCrawlAllowed = egress.isAllowed("site-crawl");

  if (!searchConsoleAllowed && !serpProviderAllowed && !aiVisibilityAllowed && !siteCrawlAllowed) {
    return new LocalExportSource();
  }

  const governor = await SeoQuotaGovernor.load(quotaLedgerPath(projectRoot), config);

  const routes: Partial<Record<SeoCapability, SeoDataSource>> = {};

  if (searchConsoleAllowed) {
    const gsc = new GscAdapter(egress, governor);
    routes["search-analytics"] = gsc;
    routes["url-inspection"] = gsc; // ADR-8: GSC wins url-inspection when on
  }

  if (siteCrawlAllowed) {
    const crawlSource = new CrawlSource(
      governor,
      new DamcrawlerCrawlEngine(egress),
      // bober: identity sanitizer for CrawlSource's OWN (defense-in-depth,
      // sc-7-3) layer only. As of the Sprint 9 fix, `DamcrawlerCrawlEngine`
      // sanitizes EVERY method (crawl/urlVisibility/linkGraph) at the
      // network->in-process boundary via the real `dam.sanitize`
      // (damcrawler-crawl-engine.ts F1) — that is now the genuine, load-
      // bearing sanitization layer for every row this source returns.
      // Leaving this second layer as identity is safe (it is redundant, not
      // sole) — wiring the loaded module's `sanitize` export through here
      // too would require exposing the engine's already-loaded damcrawler
      // module, which `selectSource` cannot reach without duplicating the
      // engine's own guard/load sequence. Follow-up: thread a real
      // `dam.sanitize` here if CrawlSource is ever given its own loader.
      new ContentSanitizer((raw) => ({ content: raw, hadThreats: false })),
    );
    routes["link-graph"] = crawlSource;
    if (!searchConsoleAllowed) {
      routes["url-inspection"] = crawlSource; // ADR-8: fallback only when GSC is off
    }
  }

  // Built unconditionally on this (not-all-off) branch and reused for
  // keywords/backlinks AND as the resolveSerpProvider dependency — each
  // self-gates its own axis on call, so constructing it here is inert until
  // a routed method is actually invoked (sprint briefing §4).
  const dataForSeo = new DataForSeoAdapter(egress, governor);

  if (serpProviderAllowed) {
    routes["keywords"] = dataForSeo;
    routes["backlinks"] = dataForSeo;
  }

  if (serpProviderAllowed || siteCrawlAllowed) {
    routes["serp"] = new SerpProviderSource(resolveSerpProvider(config, dataForSeo, egress)); // ADR-10
  }

  if (aiVisibilityAllowed) {
    // OPEN DESIGN DECISION (sprint briefing §9): `AiVisibilityAdapter`
    // requires an injected `AiVisibilityProvider`, but NO concrete provider
    // is pinned yet (Sprint 5) — routing here would force a bogus provider
    // argument. Route to the offline `LocalExportSource` arm instead (reads
    // `ai-visibility.csv`/`.json` if present, else disabled/abstain) rather
    // than constructing a non-functional live adapter.
    // bober: swap this for `new AiVisibilityAdapter(egress, governor, provider)`
    //        once a concrete AiVisibilityProvider is selected/pinned.
    routes["ai-visibility"] = new LocalExportSource();
  }

  return new CapabilitySeoRouter(routes);
}

// ── Data gathering ───────────────────────────────────────────────────

/**
 * Gathers ONLY the capabilities `WORKFLOW_CAPABILITIES` lists for `workflow`
 * (spec-20260717-seo-improver-builder, Sprint 9; ADR-7) — an omitted
 * capability is never called on `source` at all (not called-then-discarded),
 * so the metered `ai-visibility` capability incurs zero cost/network for a
 * workflow that does not consume it (sc-9-4). An omitted arm resolves
 * `undefined` on `SeoDataBundle`, which the analyzer already renders as "not
 * requested" (`analyzer.ts:127-128`).
 */
async function gatherDataBundle(
  source: SeoDataSource,
  workflow: SeoWorkflow,
  target: string,
  now: string,
): Promise<SeoDataBundle> {
  const day = now.slice(0, 10);
  const requested = new Set(WORKFLOW_CAPABILITIES[workflow]);

  const searchAnalyticsQuery: SearchAnalyticsQuery = {
    siteUrl: target,
    startDate: day,
    endDate: day,
    dimensions: ["query", "page"],
  };
  const urlInspectionQuery: UrlInspectionQuery = { siteUrl: target, inspectionUrl: target };
  const serpQuery: SerpQuery = { keyword: target, location: "us" };
  const keywordQuery: KeywordQuery = { keywords: [target], location: "us" };
  const backlinkQuery: BacklinkQuery = { target };
  const aiVisibilityQuery: AiVisibilityQuery = { target, prompts: [target] };
  const linkGraphQuery: LinkGraphQuery = { rootUrl: target };

  const [searchAnalytics, urlInspection, serp, keywords, backlinks, aiVisibility, linkGraph] = await Promise.all([
    requested.has("search-analytics") ? source.searchAnalytics(searchAnalyticsQuery) : undefined,
    requested.has("url-inspection") ? source.urlInspection(urlInspectionQuery) : undefined,
    requested.has("serp") ? source.serp(serpQuery) : undefined,
    requested.has("keywords") ? source.keywords(keywordQuery) : undefined,
    requested.has("backlinks") ? source.backlinks(backlinkQuery) : undefined,
    requested.has("ai-visibility") ? source.aiVisibility(aiVisibilityQuery) : undefined,
    requested.has("link-graph") ? source.linkGraph(linkGraphQuery) : undefined,
  ]);

  return { searchAnalytics, urlInspection, serp, keywords, backlinks, aiVisibility, linkGraph };
}

// ── Hub emission ─────────────────────────────────────────────────────

/**
 * Emit `analysis`'s cited findings into the priority hub. Best-effort:
 * `SeoHubEmitter.emit` already catches and logs sink failures internally,
 * so this helper never throws and never affects the runner's exit code.
 *
 * An injected `findingSink` (tests) is used as-is. Otherwise a `FactStore`
 * is opened lazily — only when there is at least one Finding to emit — so a
 * clean/all-uncited run never touches the filesystem for hub purposes.
 */
async function emitFindingsToHub(
  analysis: SeoAnalysis,
  projectRoot: string,
  now: string,
  findingSink: SeoFindingSink | undefined,
): Promise<void> {
  const emitter = new SeoHubEmitter();

  if (findingSink !== undefined) {
    await emitter.emit(analysis, findingSink, logger, now);
    return;
  }

  // Check emptiness BEFORE opening a store — mapToFindings is pure and cheap.
  if (emitter.mapToFindings(analysis, now).length === 0) return;

  let store: FactStore | undefined;
  try {
    await ensureFactsDir(projectRoot);
    const opened = new FactStore(factsDbPath(projectRoot));
    store = opened;
    const defaultSink: SeoFindingSink = async (finding) => {
      await ingestFinding(opened, finding, { now });
    };
    await emitter.emit(analysis, defaultSink, logger, now);
  } catch (err) {
    logger.warn(`SEO hub emission failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    store?.close();
  }
}

// ── SeoWorkflowRunner ────────────────────────────────────────────────

export class SeoWorkflowRunner {
  /**
   * Run one SEO workflow end-to-end. NEVER throws — every failure mode
   * (context/source/gather/analyze/persist errors, a `parsed: false`
   * analysis, or a blocked citation gate) resolves to `exitCode: 2`;
   * only a fully successful, non-blocked run resolves to `exitCode: 0`.
   */
  async run(input: SeoRunInput): Promise<SeoRunOutcome> {
    try {
      const target = input.target ?? input.config.seo?.defaultTarget ?? DEFAULT_TARGET_FALLBACK;

      const context = await new SeoPlaybookRetriever(new SeoPlaybookIndex()).retrieve({
        workflow: input.workflow,
        target,
      });

      const source = input.dataSource ?? (await selectSource(input.config, input.projectRoot));
      const data = await gatherDataBundle(source, input.workflow, target, input.now);

      const analyzer = input.analyzer ?? buildDefaultAnalyzer();
      const analysis = await analyzer.analyze({
        workflow: input.workflow,
        target,
        context,
        data,
        config: input.config,
        now: input.now,
      });

      if (!analysis.parsed) {
        // Fail-closed (sc-11-5): no report, ZERO hub emits.
        return { exitCode: 2 };
      }

      // Third never-encode belt (spec-20260717-seo-improver-builder, Sprint 2;
      // ADR-3): drops an LLM-synthesized banned tactic BEFORE the citation
      // gate, even when it carries a well-formed citationUrl that would
      // otherwise sail through `SeoCitationGate` untouched.
      const scrubbed = new NeverEncodeFilter().apply(analysis.findings);

      const threshold = input.config.seo?.blockThreshold ?? "critical-uncited";
      const gate = new SeoCitationGate().apply(scrubbed.kept, threshold);

      // Opt-in, downgrade-only adversarial verifier stage (Sprint 12),
      // between the citation gate and persistence. The `enabled` check
      // lives HERE (not just inside `verify()`) so the disabled path never
      // even constructs a `SeoRecommendationVerifier` or makes a provider
      // call — byte-identical to the no-verifier run (sc-12-2). The
      // verifier consumes ONLY `gate.cited` and can only shrink/downgrade
      // it; `gate.blocked` (used below) is derived from `gate.dropped` and
      // is NEVER recomputed from the verifier's output, so a verifier
      // failure structurally cannot change the exit code or block decision
      // (sc-12-4).
      let cited = gate.cited;
      if (input.config.seo?.verifier?.enabled === true) {
        const verifier = input.verifier ?? new SeoRecommendationVerifier();
        const verifyResult = await verifier.verify({
          findings: gate.cited,
          config: input.config,
          projectRoot: input.projectRoot,
          now: input.now,
        });
        cited = verifyResult.findings;
      }

      const report: SeoReport = {
        reportId: deriveReportId(input.now, input.workflow, target),
        workflow: input.workflow,
        target,
        generatedAt: input.now,
        findings: cited,
        droppedUncited: gate.dropped.length,
        droppedNeverEncode: scrubbed.dropped.length,
        dataProvenance: analysis.dataProvenance,
        verdict: gate.blocked ? "blocked" : "pass",
      };

      await new SeoReportStore().save(input.projectRoot, report);

      // Best-effort hub emit of the (possibly verifier-folded) cited
      // findings ONLY, AFTER persist. A hub failure never changes the exit
      // code.
      const citedAnalysis: SeoAnalysis = { ...analysis, findings: cited };
      await emitFindingsToHub(citedAnalysis, input.projectRoot, input.now, input.findingSink);

      return { report, exitCode: gate.blocked ? 2 : 0 };
    } catch {
      // Unexpected throw (context/source/gather/analyze/persist) -> fail-closed.
      return { exitCode: 2 };
    }
  }
}
