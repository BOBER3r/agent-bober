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
import type {
  SeoDataSource,
  SeoCapability,
  SearchAnalyticsQuery,
  UrlInspectionQuery,
  SerpQuery,
  KeywordQuery,
  BacklinkQuery,
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

// ── selectSource (sc-11-2) ───────────────────────────────────────────

function quotaLedgerPath(projectRoot: string): string {
  return `${projectRoot}/.bober/seo/quota-ledger.json`;
}

/**
 * bober: simplest correct fan-out across both live adapters when BOTH egress
 *        axes are opted in — GSC serves search-analytics/url-inspection,
 *        DataForSEO serves serp/keywords/backlinks. Swap for a capability-
 *        aware router if a third live source is ever added.
 */
class CompositeSeoSource implements SeoDataSource {
  constructor(
    private readonly gsc: GscAdapter,
    private readonly dataForSeo: DataForSeoAdapter,
  ) {}

  capabilities(): SeoCapability[] {
    return [...this.gsc.capabilities(), ...this.dataForSeo.capabilities()];
  }
  searchAnalytics(q: SearchAnalyticsQuery) {
    return this.gsc.searchAnalytics(q);
  }
  urlInspection(q: UrlInspectionQuery) {
    return this.gsc.urlInspection(q);
  }
  serp(q: SerpQuery) {
    return this.dataForSeo.serp(q);
  }
  keywords(q: KeywordQuery) {
    return this.dataForSeo.keywords(q);
  }
  backlinks(q: BacklinkQuery) {
    return this.dataForSeo.backlinks(q);
  }
  // Neither GSC nor DataForSEO serves ai-visibility/link-graph this sprint
  // (spec-20260717-seo-improver-builder, Sprint 1) — disabled unconditionally,
  // mirroring each adapter's own not-served arms.
  async aiVisibility(_q: AiVisibilityQuery): Promise<DataOutcome<AiVisibilityRow[]>> {
    return { kind: "disabled" };
  }
  async linkGraph(_q: LinkGraphQuery): Promise<DataOutcome<LinkGraphRow[]>> {
    return { kind: "disabled" };
  }
}

/**
 * Build the `SeoDataSource` for a run from the two independent egress axes.
 * Both axes off (default) -> `LocalExportSource` (zero egress, no
 * credentials touched, no governor/ledger constructed — sc-11-2). Opted-in
 * -> the live adapter(s), backed by a `SeoQuotaGovernor` loaded ONLY on this
 * branch.
 */
export async function selectSource(config: BoberConfig, projectRoot: string): Promise<SeoDataSource> {
  const egress = SeoEgressGuard.fromConfig(config);
  const searchConsoleAllowed = egress.isAllowed("search-console");
  const serpProviderAllowed = egress.isAllowed("serp-provider");

  if (!searchConsoleAllowed && !serpProviderAllowed) {
    return new LocalExportSource();
  }

  const governor = await SeoQuotaGovernor.load(quotaLedgerPath(projectRoot), config);

  if (searchConsoleAllowed && serpProviderAllowed) {
    return new CompositeSeoSource(new GscAdapter(egress, governor), new DataForSeoAdapter(egress, governor));
  }
  if (searchConsoleAllowed) {
    return new GscAdapter(egress, governor);
  }
  return new DataForSeoAdapter(egress, governor);
}

// ── Data gathering ───────────────────────────────────────────────────

/**
 * bober: gathers ALL five capabilities regardless of `workflow` — each
 *        `SeoDataSource` method degrades safely (`disabled`/`abstain`) when
 *        irrelevant, so this is always correct, just not capability-minimal.
 *        Swap for a workflow -> capability-subset map if live-adapter QPM/
 *        USD usage ever needs to be trimmed per workflow.
 */
async function gatherDataBundle(source: SeoDataSource, target: string, now: string): Promise<SeoDataBundle> {
  const day = now.slice(0, 10);
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

  const [searchAnalytics, urlInspection, serp, keywords, backlinks] = await Promise.all([
    source.searchAnalytics(searchAnalyticsQuery),
    source.urlInspection(urlInspectionQuery),
    source.serp(serpQuery),
    source.keywords(keywordQuery),
    source.backlinks(backlinkQuery),
  ]);

  return { searchAnalytics, urlInspection, serp, keywords, backlinks };
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
      const data = await gatherDataBundle(source, target, input.now);

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
