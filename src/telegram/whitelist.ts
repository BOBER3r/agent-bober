/** whitelist.ts — Pure whitelist authoriser for Telegram sender ids. No side effects, no network. */

// ── Types ─────────────────────────────────────────────────────────────

/** Immutable set of allowed numeric Telegram user ids. */
export type AllowedUsers = ReadonlySet<number>;

// ── Parsing ───────────────────────────────────────────────────────────

/**
 * Parses TELEGRAM_ALLOWED_USERS from the given env map.
 * Expects a comma-separated list of positive integer Telegram user ids.
 * Empty or missing env var returns an empty set.
 * Whitespace around ids is trimmed; non-numeric tokens are silently ignored.
 */
export function parseAllowedUsers(env: Record<string, string | undefined>): AllowedUsers {
  const raw = env["TELEGRAM_ALLOWED_USERS"] ?? "";
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map(Number)
    .filter((n) => Number.isFinite(n) && Number.isInteger(n) && n > 0);
  return new Set(ids);
}

// ── Authorisation ─────────────────────────────────────────────────────

/**
 * Returns true if the numeric sender id is present in the allowed set.
 */
export function isAllowed(id: number, allowed: AllowedUsers): boolean {
  return allowed.has(id);
}

// ── Denial reply ──────────────────────────────────────────────────────

/**
 * Returns a denial message that echoes the sender's exact numeric id as a substring (sc-1-4).
 * The id appears verbatim inside the message so the sender knows which account was rejected.
 */
export function denialReply(id: number): string {
  return `Access denied. Your Telegram id (${id}) is not in the allowed list.`;
}
