/**
 * Research note serializer — PURE markdown note builder for multi-model research runs.
 *
 * PURE / NO fs / NO network / NO Date.now()
 * All timestamps are injected parameters; the wall clock is read ONLY at the CLI boundary.
 *
 * Mirrors src/medical/research/research-note.ts in structure.
 * Uses serializeFrontmatter (scalars + string-arrays ONLY — never pass objects).
 */

import { join } from "node:path";

import { serializeFrontmatter } from "../vault/frontmatter.js";
import type { ResearchJob } from "./types.js";

// ── Path helper ───────────────────────────────────────────────────────

/**
 * Derive the canonical path for a research note under the vault.
 * Output: <vaultRoot>/research/<YYYY-MM-DD>-<marker>.md
 * Date is sliced from the injected ISO string — never wall-clock.
 */
export function researchNotePath(vaultRoot: string, marker: string, now: string): string {
  const date = now.slice(0, 10); // YYYY-MM-DD
  return join(vaultRoot, "research", `${date}-${marker}.md`);
}

// ── Contribution shape ────────────────────────────────────────────────

/** One labelled model answer collected by the runner. */
export interface ModelContribution {
  /** Canonical model label, e.g. "openai-compat/deepseek". */
  label: string;
  /** The model's answer text. */
  text: string;
}

// ── Serializer ────────────────────────────────────────────────────────

/**
 * Serialize a multi-model research run into a vault note string.
 *
 * Frontmatter fields (all required by sc-2-2):
 *   title, jobId, question, models (string[]), generatedAt, domain, type, status
 *
 * Body: per-model contribution sections — records WHICH model label produced each answer.
 *
 * PITFALL: models must be string[] (labels), never RoleProviderBlock[].
 * serializeFrontmatter renders nested objects as "[object Object]".
 */
export function serializeResearchNote(
  job: ResearchJob,
  labels: string[],
  contributions: ModelContribution[],
  now: string,
  sources: string[] = [],   // Sprint 3: optional source URLs; default [] => byte-identical off-path
): string {
  const frontmatter: Record<string, unknown> = {
    title: `Research — ${job.question}`,
    jobId: job.id,           // sc-2-2 required
    question: job.question,  // sc-2-2 required
    models: labels,          // sc-2-2 required — array of strings (safe for serializeFrontmatter)
    generatedAt: now,        // sc-2-2 required — injected ISO, never wall-clock
    domain: job.domain ?? "research",
    type: "research",
    status: "open",
    // Sprint 3: spread sources only when non-empty (string[] URLs; never objects — see pitfall above)
    ...(sources.length > 0 ? { sources } : {}),
  };

  const contributionsSections = contributions
    .map((c) => `### ${c.label}\n\n${c.text}`)
    .join("\n\n");

  const body = `\n## ${job.question}\n\n${contributionsSections}\n`;

  return serializeFrontmatter(frontmatter, body);
}
