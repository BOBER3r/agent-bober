/** CalendarTokenStore — 0600 Google Calendar token sidecar. NO network (mirrors whoop-token.ts). */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir } from "../utils/fs.js";

// ── CalendarTokenStore ───────────────────────────────────────────────

/**
 * Manages a Google Calendar OAuth token in a 0600 sidecar file at
 * .bober/calendar/google-token.json.
 *
 * readToken() returns undefined when the sidecar is absent or corrupt —
 * fail-closed so the connector refuses without a token rather than crashing.
 *
 * writeToken() persists the token with mode 0600 (mirrors whoop-token.ts:84).
 *
 * NOTE: The OAuth acquire handshake is out of scope — the token is provisioned
 * out-of-band into the sidecar. Hosted OAuth is unfit for unattended/cron runs;
 * use the local .ics fallback (`bober calendar plan --export-ics`) for scheduled use.
 *
 * NO network imports in this file; all HTTP lives outside this module.
 *
 * bober: env-var / file sidecar; swap for OS keychain if per-user isolation
 *        is needed across multiple OS accounts (deferred).
 */
export class CalendarTokenStore {
  constructor(private readonly projectRoot: string) {}

  // ── Path ──────────────────────────────────────────────────────────

  private path(): string {
    return join(this.projectRoot, ".bober", "calendar", "google-token.json");
  }

  // ── Token sidecar ─────────────────────────────────────────────────

  /**
   * Returns the stored token, or undefined when the sidecar is absent or corrupt.
   * Fail-closed: any read/parse error => undefined (not yet authorised).
   */
  async readToken(): Promise<string | undefined> {
    try {
      const data = JSON.parse(
        await readFile(this.path(), "utf-8"),
      ) as { token?: unknown };
      return typeof data.token === "string" ? data.token : undefined;
    } catch {
      return undefined; // absent or corrupt => not yet authorised
    }
  }

  /**
   * Persist token at .bober/calendar/google-token.json with mode 0600.
   * Directory is created if absent (mirrors whoop-token.ts:80-84).
   */
  async writeToken(token: string): Promise<void> {
    await ensureDir(join(this.projectRoot, ".bober", "calendar"));
    await writeFile(
      this.path(),
      JSON.stringify({ token }, null, 2) + "\n",
      { encoding: "utf-8", mode: 0o600 },
    );
  }
}
