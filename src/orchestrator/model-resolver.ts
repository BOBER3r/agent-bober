/**
 * Centralized model name resolution.
 *
 * Maps user-friendly model names (from bober.config.json) to
 * actual Anthropic model IDs. Also accepts exact model IDs
 * as pass-through.
 */
export function resolveModel(choice: string): string {
  switch (choice) {
    case "opus":
      return "claude-opus-4-6";
    case "sonnet":
      return "claude-sonnet-4-6";
    case "haiku":
      return "claude-haiku-4-5-20251001";
    default:
      // Pass through exact model IDs (e.g. "claude-sonnet-4-6")
      return choice;
  }
}
