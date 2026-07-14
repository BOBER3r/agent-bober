/**
 * Vault note model — the canonical in-memory shape of an Obsidian markdown note.
 *
 * Domain-agnostic: frontmatter is an open Record; no domain-specific keys are
 * hardcoded here. Consumers narrow frontmatter values at their own use sites.
 * No execution logic lives here — types only.
 */

// ── Vault note ──────────────────────────────────────────────────────

/** A parsed Obsidian vault note: YAML frontmatter + opaque markdown body + source path. */
export interface VaultNote {
  /**
   * Parsed YAML frontmatter. Values follow Dataview conventions:
   * string | number | string[] (for lists) or a status enum string.
   */
  frontmatter: Record<string, unknown>;
  /** Opaque markdown body — everything after the closing `---` delimiter, preserved verbatim. */
  body: string;
  /** Absolute or vault-relative path the note was read from / will be written to. */
  path: string;
}

// ── Status enum ─────────────────────────────────────────────────────

/**
 * Documented Dataview-compatible status enum.
 * Stored as a plain string in frontmatter — no coercion at runtime.
 */
export type NoteStatus = "active" | "superseded";
