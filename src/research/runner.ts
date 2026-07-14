/**
 * runResearchJob — deterministic multi-model research runner.
 *
 * Flow:
 *   1. Resolve >=2 distinct provider/model blocks via model-diversity.
 *   2. Query each block via the injected queryModel dep (no SDK imports here).
 *   3. Collect labelled contributions.
 *   4. Serialize into a markdown vault note and write it to disk.
 *   5. Build one Finding and emit it via the injected findingSink EXACTLY once.
 *   6. Return { notePath, models, finding }.
 *
 * PURE deps-injection contract:
 *   - queryModel  — provider-agnostic; CLI binds to createClient().chat()
 *   - findingSink — hub writer; CLI binds to ingestFinding(store, f, {now})
 *   - now         — injected ISO timestamp; never call new Date() in this module
 *   - vaultRoot   — target vault dir; must be writable by the caller
 *
 * Clock discipline: `now` is always stamped at the CLI .action() boundary.
 * This module never calls new Date() or Date.now().
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createHash } from "node:crypto";

import type { Finding } from "../hub/finding.js";
import type { RoleProviderBlock } from "../fleet/tier-policy.js";
import type { ResearchJob } from "./types.js";
import { diverseBlocks, modelLabel } from "./model-diversity.js";
import {
  researchNotePath,
  serializeResearchNote,
  type ModelContribution,
} from "./note-writer.js";
import { retrieve, type RetrievalClient } from "./online-retrieval.js";
import type { ResearchEgressGuard } from "./egress.js";

// ── Public types ──────────────────────────────────────────────────────

/** Provider-agnostic query function — wraps a single LLM chat call. */
export type QueryModel = (block: RoleProviderBlock, prompt: string) => Promise<string>;

/** Hub Finding emitter — called exactly once after the note is written. */
export type FindingSink = (finding: Finding) => Promise<void>;

/** Injected dependencies for runResearchJob. */
export interface RunDeps {
  /** Provider-agnostic query fn — NO SDK import; CLI binds to createClient(). */
  queryModel: QueryModel;
  /** Finding sink — CLI binds to ingestFinding(store, f, { now }). */
  findingSink: FindingSink;
  /** Injected ISO timestamp — stamped at the CLI boundary; never read the clock here. */
  now: string;
  /** Writable vault root directory. */
  vaultRoot: string;
  // ── Sprint 3 (additive, optional — omit => byte-identical offline run) ──
  /** Research egress guard — when absent, retrieval is skipped entirely (zero outbound). */
  egress?: ResearchEgressGuard;
  /** Injected retrieval client — when absent, retrieval is skipped entirely. */
  retrievalClient?: RetrievalClient;
}

/** Result returned by runResearchJob. */
export interface RunResult {
  /** Absolute path of the written vault note. */
  notePath: string;
  /** Canonical model labels queried (e.g. ["openai-compat/deepseek", "openai-compat/grok"]). */
  models: string[];
  /** The Finding emitted to the hub. */
  finding: Finding;
}

// ── Domain analyzer registry ──────────────────────────────────────────

/**
 * A domain-specific analyzer can post-process contributions to produce a
 * custom Finding. If no analyzer is registered for a domain, the generic
 * default is used (multi-model synthesis with neutral defaults).
 *
 * bober: registry is a simple Map; swap for a plugin loader if the number of
 *        domains grows beyond ~5 (the current set is research/medical/coding).
 *        Do NOT register src/medical/ analyzers here — that is a future sprint.
 */
export type DomainAnalyzer = (
  job: ResearchJob,
  contributions: ModelContribution[],
  now: string,
) => Finding;

const analyzerRegistry = new Map<string, DomainAnalyzer>();

/**
 * Register a domain-specific analyzer. The key is the domain string
 * (e.g. "medical"). Overwrites any existing registration for that domain.
 * Called by domain modules (never by src/medical/ in this sprint).
 */
export function registerAnalyzer(domain: string, analyzer: DomainAnalyzer): void {
  analyzerRegistry.set(domain, analyzer);
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Derive a content-stable Finding id from domain|title|kind. */
function deriveFindingId(domain: string, title: string, kind: string): string {
  return createHash("sha256")
    .update(`${domain}|${title}|${kind}`)
    .digest("hex")
    .slice(0, 16);
}

/** Build the generic Finding for a completed research run. */
function buildFinding(
  job: ResearchJob,
  contributions: ModelContribution[],
  now: string,
): Finding {
  const domain = job.domain ?? "research";
  const title = `Research: ${job.question}`;
  const kind = "watch" as const;
  const id = deriveFindingId(domain, title, kind);

  // evidence = per-model contribution labels (cited sources)
  const evidence = contributions.map((c) => `${c.label}: ${c.text.slice(0, 120)}`);

  return {
    id,
    domain,
    title,
    kind,
    urgency: 2,
    severity: 2,
    evidence,
    surfacedAt: now,
    tags: ["research", ...(job.domain !== undefined ? [`domain:${job.domain}`] : [])],
    status: "open",
  };
}

// ── Runner ────────────────────────────────────────────────────────────

/**
 * Execute one research job: query >=2 distinct model blocks, write a vault
 * note, and emit exactly ONE Finding to the injected sink.
 *
 * @param job  - The stored ResearchJob definition.
 * @param deps - Injected dependencies (queryModel, findingSink, now, vaultRoot).
 * @returns    RunResult with the note path, model labels, and the emitted Finding.
 */
export async function runResearchJob(
  job: ResearchJob,
  deps: RunDeps,
): Promise<RunResult> {
  const { queryModel, findingSink, now, vaultRoot } = deps;

  // 1. Resolve >=2 distinct provider/model blocks (sc-2-1)
  const blocks = diverseBlocks(job.tier);
  // Guard: need at least 2 distinct blocks to satisfy sc-2-1
  if (blocks.length < 2) {
    throw new Error(
      `model-diversity returned ${blocks.length} block(s); need >=2 for a multi-model run`,
    );
  }

  // 2. Query each block with a research prompt
  const prompt = `Answer the following research question concisely and accurately:\n\n${job.question}`;
  const contributions: ModelContribution[] = [];
  for (const block of blocks) {
    const text = await queryModel(block, prompt);
    contributions.push({ label: modelLabel(block), text });
  }

  // ── Sprint 3: gated online-research retrieval (axis OFF default => skipped entirely) ──
  // When egress is absent or axis is off: sourceUrls stays [] and the retrieval client
  // is NEVER constructed or invoked — zero outbound requests (sc-3-3 off-path proof).
  let sourceUrls: string[] = [];
  if (deps.egress?.isAllowed("online-research") === true && deps.retrievalClient !== undefined) {
    const sources = await retrieve(job.question, deps.retrievalClient);
    sourceUrls = sources.map((s) => s.url);
  }

  // 3. Build the note content (PURE — no fs)
  const labels = contributions.map((c) => c.label);
  const noteContent = serializeResearchNote(job, labels, contributions, now, sourceUrls);

  // 4. Write the note to disk (sc-2-2)
  // Marker = first 12 chars of job id (stable slug for the filename)
  const marker = job.id.slice(0, 12);
  const notePath = researchNotePath(vaultRoot, marker, now);
  await mkdir(dirname(notePath), { recursive: true });
  await writeFile(notePath, noteContent, "utf-8");

  // 5. Build and emit exactly ONE Finding (sc-2-3)
  const domain = job.domain ?? "research";
  const analyzer = analyzerRegistry.get(domain);
  const finding =
    analyzer !== undefined
      ? analyzer(job, contributions, now)
      : buildFinding(job, contributions, now);

  await findingSink(finding);

  return { notePath, models: labels, finding };
}
