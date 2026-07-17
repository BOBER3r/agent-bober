/**
 * SeoBuildRunner — drives reportId -> approved hub findings -> SeoBuilder.build
 * -> SeoDraftStore persist -> best-effort hub 'action' emission
 * (spec-20260717-seo-improver-builder, Sprint 13). NEVER throws; exit 0/2.
 * `now` is caller-injected (never re-stamped here) — mirrors
 * `SeoWorkflowRunner.run` (`../runner.ts`) fail-closed/never-throw discipline
 * and `emitFindingsToHub`'s best-effort hub-emit pattern.
 *
 * reportId -> approved-findings linkage (no stored reportId link exists on
 * hub findings, sprint briefing §5): the report is read FIRST (supplies
 * `report.target`, required by `SeoBuilder.build`, and detects an unknown
 * reportId), then approved SEO findings are narrowed to
 * `af.workflow === report.workflow` — the only available linkage.
 */
import { createHash } from "node:crypto";

import type { BoberConfig } from "../../config/schema.js";
import { FactStore, factsDbPath, ensureFactsDir } from "../../state/facts.js";
import { ingestFinding } from "../../hub/finding-store.js";
import type { Finding } from "../../hub/finding.js";
import { logger } from "../../utils/logger.js";
import { SeoReportStore } from "../report-store.js";
import { NeverEncodeFilter } from "../never-encode-filter.js";
import type { SeoFindingSink } from "../hub-emitter.js";
import { SeoBuilder } from "./seo-builder.js";
import { readApprovedSeoFindings } from "./hub-approved-source.js";
import type { ApprovedFinding } from "./approved-finding.js";
import type { SeoDraft } from "./draft-types.js";
import { SeoDraftStore } from "./draft-store.js";
import type { SeoDraftBundle } from "./draft-store.js";

// ── Public types ─────────────────────────────────────────────────────

export type SeoBuildRunInput = {
  projectRoot: string;
  config: BoberConfig;
  reportId: string;
  /** ISO timestamp, stamped ONCE by the `seo build` CLI action. */
  now: string;
  // ── TEST injections (mirror runner.ts's dataSource/analyzer/findingSink) ──
  /** Default = `new SeoReportStore()`. */
  reportStore?: SeoReportStore;
  /** Default = `new SeoDraftStore()`. */
  draftStore?: SeoDraftStore;
  /** Default = `new SeoBuilder(new NeverEncodeFilter())`. */
  builder?: SeoBuilder;
  /** Default = open a real `FactStore` + `readApprovedSeoFindings`. */
  readApproved?: (projectRoot: string) => Promise<ApprovedFinding[]>;
  /** Default binds `ingestFinding` to a real `FactStore`. */
  findingSink?: SeoFindingSink;
};

export type SeoBuildRunOutcome = {
  drafts?: SeoDraft[];
  skipped?: number;
  exitCode: 0 | 2;
};

// ── Defaults ─────────────────────────────────────────────────────────

/** Opens a real `FactStore` (closed in `finally`) to read approved SEO findings. */
async function defaultReadApproved(projectRoot: string): Promise<ApprovedFinding[]> {
  await ensureFactsDir(projectRoot);
  const store = new FactStore(factsDbPath(projectRoot));
  try {
    return readApprovedSeoFindings(store);
  } finally {
    store.close();
  }
}

/**
 * Map a `SeoDraft` -> hub `Finding` (kind ALWAYS `"action"` — every
 * `SeoDraft` carries `humanApprovalRequired: true`, the type literal,
 * `draft-types.ts:29`). Mirrors `SeoHubEmitter`'s title/id/evidence
 * conventions (`../hub-emitter.ts:54-90`) but maps `SeoDraft`, not
 * `SeoFinding` — there is no existing draft->Finding mapper to reuse.
 *
 * bober: `SeoDraft` carries no severity/urgency of its own (it is
 * decoupled from the source finding by `SeoBuilder.build`) — default both
 * to `3` (mid-scale) rather than inventing a provenance link back to the
 * approved finding's severity. Revisit if a future sprint threads
 * `ApprovedFinding.severity` through `SeoBuildResult`.
 */
function draftToFinding(draft: SeoDraft, now: string): Finding {
  const title = `[seo] draft ${draft.kind}: ${draft.artifact.slice(0, 80)}`;
  const kind: Finding["kind"] = "action";

  return {
    id: deriveDraftFindingId(title, kind),
    domain: "seo",
    title,
    kind,
    urgency: 3,
    severity: 3,
    evidence: [draft.artifact, `cite:${draft.sourceCitationUrl}`],
    surfacedAt: now,
    tags: ["seo", `playbook:${draft.playbookRef}`, `draft-kind:${draft.kind}`, "seo-draft"],
    status: "open",
  };
}

/** Content-stable id: hash of domain|title|kind (mirrors `../hub-emitter.ts:32-34`). */
function deriveDraftFindingId(title: string, kind: string): string {
  return createHash("sha256").update(`seo|${title}|${kind}`).digest("hex").slice(0, 16);
}

/**
 * Best-effort emit each draft as a hub 'action' Finding. NEVER throws and
 * NEVER changes the caller's exit code — mirrors `emitFindingsToHub`
 * (`../runner.ts:391-421`). Checks emptiness BEFORE opening a store so a
 * fully-skipped build never touches the hub (sprint briefing Pitfall 8).
 */
async function emitDraftsToHub(
  drafts: SeoDraft[],
  projectRoot: string,
  now: string,
  findingSink: SeoFindingSink | undefined,
): Promise<void> {
  if (drafts.length === 0) return;

  const findings = drafts.map((d) => draftToFinding(d, now));

  if (findingSink !== undefined) {
    try {
      for (const finding of findings) {
        await findingSink(finding);
      }
    } catch (err) {
      logger.warn(`SEO draft hub emission failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return;
  }

  let store: FactStore | undefined;
  try {
    await ensureFactsDir(projectRoot);
    const opened = new FactStore(factsDbPath(projectRoot));
    store = opened;
    for (const finding of findings) {
      await ingestFinding(opened, finding, { now });
    }
  } catch (err) {
    logger.warn(`SEO draft hub emission failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    store?.close();
  }
}

// ── SeoBuildRunner ───────────────────────────────────────────────────

export class SeoBuildRunner {
  /**
   * Run one `seo build <reportId>` invocation end-to-end. NEVER throws:
   * every fallible step (report read, approved-findings read, build,
   * persist) is wrapped in one top-level try/catch -> `exitCode: 2`. An
   * unknown reportId or a report with no approved findings is a CLEAN
   * `exitCode: 0` with an informational stdout message and ZERO hub emits
   * (sc-13-4) — `2` is reserved for a caught unexpected error.
   */
  async run(input: SeoBuildRunInput): Promise<SeoBuildRunOutcome> {
    try {
      const report = await (input.reportStore ?? new SeoReportStore()).read(
        input.projectRoot,
        input.reportId,
      );
      if (report === null) {
        process.stdout.write(`seo build: no report found for id "${input.reportId}"\n`);
        return { exitCode: 0 };
      }

      const approvedAll = await (input.readApproved ?? defaultReadApproved)(input.projectRoot);
      // Narrow to the report's workflow — the only available reportId->
      // approved-findings linkage (sprint briefing §5).
      const approved = approvedAll.filter((a) => a.workflow === report.workflow);
      if (approved.length === 0) {
        process.stdout.write(`seo build: report "${input.reportId}" has no approved findings\n`);
        return { exitCode: 0 };
      }

      const builder = input.builder ?? new SeoBuilder(new NeverEncodeFilter());
      const { drafts, skipped } = builder.build({
        approvedFindings: approved,
        target: report.target,
        config: input.config,
        now: input.now,
      });

      const bundle: SeoDraftBundle = {
        reportId: report.reportId,
        target: report.target,
        generatedAt: input.now,
        drafts,
        skipped,
      };
      await (input.draftStore ?? new SeoDraftStore()).save(input.projectRoot, bundle);

      // Best-effort AFTER persist — a hub failure never changes the exit code.
      await emitDraftsToHub(drafts, input.projectRoot, input.now, input.findingSink);

      return { drafts, skipped, exitCode: 0 };
    } catch {
      // Unexpected throw (report/approved-findings read, build, or persist) -> fail-closed.
      return { exitCode: 2 };
    }
  }
}
