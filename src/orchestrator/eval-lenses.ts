// ── Lens catalog ────────────────────────────────────────────────────

/** Built-in lens focus fragments. Each must be distinct and non-empty (C1). */
const LENS_CATALOG: Record<string, string> = {
  correctness:
    "Focus on whether the implementation actually satisfies each success criterion verbatim. Check that all required behaviours exist, all edge cases are handled, and the contract's definitionOfDone is met.",
  security:
    "Focus on injection vulnerabilities, authentication and authorisation gaps, secret handling, unsafe input validation, and any path traversal or privilege escalation risks.",
  regression:
    "Focus on whether previously working behaviour still works after the changes. Verify that pre-existing tests pass, that no public API or config interface was broken, and that the sprint diff does not silently remove functionality.",
  quality:
    "Focus on principles violations, dead code, misleading naming, smells, duplicated logic, and whether the implementation follows the project's established patterns and conventions.",
};

// ── Resolver ────────────────────────────────────────────────────────

/**
 * Resolve a lens name to its focus fragment.
 * Returns the catalog entry for a known lens, or a generic non-empty
 * fallback for any unknown custom string — never throws (C1).
 */
export function resolveLensFocus(lens: string): string {
  return (
    LENS_CATALOG[lens] ?? `Evaluate specifically through the '${lens}' lens.`
  );
}
