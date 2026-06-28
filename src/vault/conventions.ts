/**
 * Vault conventions — canonical Dataview frontmatter status values and the
 * gitignored attachments directory name. Single source of truth so the reindex
 * path and downstream domains share ONE definition (no per-file duplicates).
 *
 * PURE: constants only — no fs, no clock, no network, no logic.
 *
 * bober: ATTACHMENTS_DIR names the binary-attachment convention but does NOT
 *        enforce it at runtime (no mkdir, no .gitignore write) — documentation only.
 *        Swap for a runtime guard if the evaluator ever requires enforcement.
 */

import type { NoteStatus } from "./types.js";

/** Frontmatter status for a live note included in the active FactStore index. */
export const ACTIVE_STATUS: NoteStatus = "active";

/** Frontmatter status that excludes a note from the active index (reindex skip). */
export const SUPERSEDED_STATUS: NoteStatus = "superseded";

/**
 * Vault subdirectory holding binary attachments (images, PDFs, etc.).
 * Binary attachments stay OUT of git — add this directory to .gitignore.
 * Convention only — nothing is auto-created or enforced at runtime.
 */
export const ATTACHMENTS_DIR = "attachments" as const;
