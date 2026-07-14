/**
 * Research note serializer — PURE citation-frontmatter markdown note for MedlinePlus findings.
 *
 * PURE / NO network / NO LLM / NO Date.now()
 * All timestamps are injected parameters; the wall clock is read ONLY at the CLI boundary.
 *
 * Produces a vault research note with flattened citation frontmatter (title/url/source
 * as parallel arrays) so serializeFrontmatter (scalar/array-of-scalar only) renders correctly.
 * See: Pattern E / briefing §2 (the nested-object pitfall with Citation[]).
 */

import type { MedicalAnswer } from "../types.js";
import { serializeFrontmatter } from "../../vault/frontmatter.js";
import { join } from "node:path";

// ── Path helper ──────────────────────────────────────────────────────

/**
 * Derive the canonical path for a research note under the vault.
 * Output: <vaultDir>/research/<YYYY-MM-DD>-<marker>.md
 * Date is sliced from the injected ISO string — never wall-clock.
 */
export function researchNotePath(vaultDir: string, marker: string, now: string): string {
  const date = now.slice(0, 10); // YYYY-MM-DD
  return join(vaultDir, "research", `${date}-${marker}.md`);
}

// ── Serializer ───────────────────────────────────────────────────────

/**
 * Serialize a grounded MedicalAnswer into a vault research note string.
 *
 * Frontmatter:
 *   title, domain, type, marker, source (scalar "medlineplus"),
 *   citationTitles[] (strings), citationUrls[] (strings), surfacedAt, status.
 *
 * PITFALL: Citation is an object {title, url, source}. Passing citations straight into
 * serializeFrontmatter would render "  - [object Object]". This function FLATTENS them
 * into parallel arrays-of-strings (citationTitles, citationUrls) + a scalar `source`.
 *
 * Body: answer.body + disclaimerFooter.
 */
export function serializeResearchNote(marker: string, answer: MedicalAnswer, now: string): string {
  // Flatten Citation[] into scalar/array-of-string fields (Pattern E)
  const citationTitles = answer.citations.map((c) => c.title);
  const citationUrls = answer.citations.map((c) => c.url);

  const frontmatter: Record<string, unknown> = {
    title: `Latest evidence — ${marker}`,
    domain: "medical",
    type: "research",
    marker,
    source: "medlineplus", // scalar — satisfies sc-5-3 "source 'medlineplus'"
    citationTitles, // array of strings — serializeFrontmatter safe
    citationUrls, // array of strings — serializeFrontmatter safe
    surfacedAt: now, // injected ISO string — never wall-clock
    status: "open",
  };

  const body = `\n## Latest evidence on ${marker}\n\n${answer.body}\n\n${answer.disclaimerFooter}\n`;

  return serializeFrontmatter(frontmatter, body);
}
