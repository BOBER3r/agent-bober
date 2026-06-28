/**
 * runResearchJob — egress-gated online research job (schedulable entrypoint).
 *
 * When literature-retrieval is OFF: returns { disabled: true, notesWritten: 0, findingsWritten: 0 }
 * IMMEDIATELY — NO retriever constructed, ZERO egress. This is the zero-egress proof (sc-5-2).
 *
 * When ON: retrieves MedlinePlus passages via LiteratureRetriever, grounds notes through
 * synthesizeGrounded (fail-closed grounding critic), writes research notes and optional watch
 * findings to the vault.
 *
 * PURE clock: `now` is injected — NEVER call Date.now()/new Date() here.
 * NO network imports — ADR-6 restricts network to medline-source.ts only.
 *
 * Exported as the schedulable entrypoint for spec-20260628-research-scheduler.
 * Signature: (projectRoot, config, {markers, now}, deps?) => Promise<ResearchSummary>
 */

import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";

import type { BoberConfig } from "../../config/schema.js";
import { EgressGuard } from "../egress.js";
import { LiteratureRetriever } from "../retrieval/literature.js";
import { synthesizeGrounded } from "../retrieval/literature.js";
import { buildMedicalInferenceClient, type ClientFactory } from "../inference.js";
import { DisclaimerComposer } from "../disclaimer.js";
import { writeFinding } from "../analysis/finding-writer.js";
import { findingId } from "../analysis/finding.js";
import { ensureDir } from "../../utils/fs.js";
import type { MedicalFinding } from "../analysis/finding.js";
import type { LLMClient } from "../../providers/types.js";
import type { RetrievalOutcome } from "../retrieval/medline-source.js";
import { serializeResearchNote, researchNotePath } from "./research-note.js";

// ── Types ──────────────────────────────────────────────────────────────

/** Summary returned by runResearchJob. */
export interface ResearchSummary {
  notesWritten: number;
  findingsWritten: number;
  disabled: boolean;
}

/**
 * Injectable dependencies for runResearchJob.
 * Production callers pass no deps — all defaults are wired from real modules.
 * Tests inject fakes for: retriever (avoids MedlineSource), clientFactory (spy), writeFindingFn.
 */
export interface ResearchDeps {
  /** Injectable retriever — defaults to a real LiteratureRetriever when axis is ON. */
  retriever?: {
    retrieve(query: string): Promise<RetrievalOutcome>;
  };
  /** Injectable LLMClient for synthesis — use clientFactory instead when testing sc-5-5. */
  llmClient?: LLMClient;
  /** Injectable client factory so tests can spy on which provider/endpoint is requested (sc-5-5). */
  clientFactory?: ClientFactory;
  /** Injectable finding writer so tests avoid real fs writes. Defaults to writeFinding. */
  writeFindingFn?: typeof writeFinding;
}

// ── runResearchJob ─────────────────────────────────────────────────────

/**
 * Run the online research job for the given markers.
 *
 * Gating order (load-bearing — mirrors runImportLabs pattern at medical.ts:165-178):
 *   1. Build EgressGuard.
 *   2. axis OFF -> return {disabled:true, notesWritten:0, findingsWritten:0} BEFORE any construction.
 *   3. Build synthesis client via buildMedicalInferenceClient (fail-closed local unless cloud-inference ON).
 *   4. Resolve vault dir.
 *   5. For each marker: retrieve -> synthesizeGrounded -> abstained? skip : write note + finding.
 *   6. Return { disabled: false, notesWritten, findingsWritten }.
 *
 * @param projectRoot  Absolute project root path
 * @param config       Loaded BoberConfig
 * @param opts         { markers: string[]; now: string } — clock injected NEVER read here
 * @param deps         Optional injectable dependencies (tests only)
 */
export async function runResearchJob(
  projectRoot: string,
  config: BoberConfig,
  opts: { markers: string[]; now: string },
  deps: ResearchDeps = {},
): Promise<ResearchSummary> {
  // ── 1. Egress guard ─────────────────────────────────────────────────
  const egress = EgressGuard.fromConfig(config);

  // ── 2. Zero-egress short-circuit (sc-5-2) ────────────────────────────
  // Return BEFORE constructing any LiteratureRetriever / MedlineSource (zero-egress proof).
  if (!egress.isAllowed("literature-retrieval")) {
    return { disabled: true, notesWritten: 0, findingsWritten: 0 };
  }

  // ── 3. Synthesis client (fail-closed local unless cloud-inference ON) (sc-5-5) ─
  const { client, model } = buildMedicalInferenceClient(config, egress, deps.clientFactory);
  const llm: LLMClient = deps.llmClient ?? client;

  // ── 4. Vault dir resolution (mirrors review-pass.ts:78-79) ─────────
  const vaultDir =
    config.medical?.vaultDir ?? join(projectRoot, ".bober", "medical", "vault");

  // ── 5. Retriever (constructed ONLY here — axis-on branch) ───────────
  // Injecting deps.retriever keeps tests free of real MedlineSource construction.
  const retriever = deps.retriever ?? new LiteratureRetriever(egress);

  const footer = new DisclaimerComposer().footer();
  const writeFindingFn = deps.writeFindingFn ?? writeFinding;

  let notesWritten = 0;
  let findingsWritten = 0;

  // ── 6. Per-marker retrieval + grounded synthesis ─────────────────────
  for (const marker of opts.markers) {
    const query = `Latest evidence on ${marker}`;

    // Retrieve passages from MedlinePlus
    const outcome = await retriever.retrieve(query);

    // Grounded synthesis with fail-closed critic gate
    const result = await synthesizeGrounded(query, outcome, llm, footer, model);

    // sc-5-4: if critic rejected / abstained -> write NO clinical note for this topic
    if (result.answer.abstained) {
      // Count as abstained — do not persist uncited synthesis
      continue;
    }

    // Non-abstained: write research note under <vault>/research/<date>-<marker>.md
    const notePath = researchNotePath(vaultDir, marker, opts.now);
    const noteContent = serializeResearchNote(marker, result.answer, opts.now);
    await ensureDir(dirname(notePath));
    await writeFile(notePath, noteContent, "utf-8");
    notesWritten++;

    // Optional watch finding (Pattern G)
    const finding: MedicalFinding = {
      id: findingId("medical", marker, "new-evidence"),
      domain: "medical",
      title: `New evidence on ${marker}`,
      kind: "watch",
      urgency: 2,
      severity: 2,
      evidence: result.answer.citations.map((c) => c.url),
      surfacedAt: opts.now, // injected — never wall-clock
      tags: ["research", marker],
      status: "open",
    };
    await writeFindingFn(vaultDir, finding);
    findingsWritten++;
  }

  return { disabled: false, notesWritten, findingsWritten };
}
