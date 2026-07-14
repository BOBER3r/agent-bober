/**
 * Finding vault writer — writes MedicalFinding notes and the Dataview dashboard.
 *
 * PURE file I/O only.
 * NO network. NO LLM. NO Date.now(). All timestamps are injected via MedicalFinding.surfacedAt.
 *
 * Mirrors writeLabNote pattern at src/medical/lab-note.ts:191-236.
 * Uses node:fs/promises only (principles: no sync fs).
 */

import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";

import { ensureDir } from "../../utils/fs.js";
import { serializeFindingToMarkdown } from "./finding.js";
import type { MedicalFinding } from "./finding.js";

// -- Finding writer -------------------------------------------------------

/**
 * Write a MedicalFinding to <vaultDir>/findings/<finding.id>.md.
 * Creates parent directories as needed (ensureDir mirrors lab-note.ts:232).
 * Returns the absolute path written.
 *
 * Finding ids are deterministic hex strings (no colons, no spaces) — safe as filenames.
 */
export async function writeFinding(vaultDir: string, finding: MedicalFinding): Promise<string> {
  const notePath = join(vaultDir, "findings", `${finding.id}.md`);
  const serialized = serializeFindingToMarkdown(finding);
  await ensureDir(dirname(notePath));
  await writeFile(notePath, serialized, "utf-8");
  return notePath;
}

// -- Dashboard writer -----------------------------------------------------

/**
 * Dataview dashboard content.
 * TABLE rows: urgency, severity, kind, status for all medical findings, sorted by urgency DESC.
 */
const DASHBOARD_CONTENT = `---
title: Medical Findings Dashboard
domain: medical
---

# Medical Findings Dashboard

\`\`\`dataview
TABLE urgency, severity, kind, status
FROM "findings"
WHERE domain = "medical"
SORT urgency DESC
\`\`\`
`;

/**
 * Write the Dataview findings dashboard to <vaultDir>/findings/dashboard.md.
 * The dashboard references frontmatter fields urgency, severity, kind, and status (sc-1-5).
 * Creates parent directories as needed.
 * Returns the absolute path written.
 */
export async function writeDashboard(vaultDir: string): Promise<string> {
  const dashPath = join(vaultDir, "findings", "dashboard.md");
  await ensureDir(dirname(dashPath));
  await writeFile(dashPath, DASHBOARD_CONTENT, "utf-8");
  return dashPath;
}
