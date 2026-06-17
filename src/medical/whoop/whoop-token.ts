/** WhoopTokenStore — WHOOP OAuth creds (env) + 0600 refresh-token sidecar. NO network (ADR-2). */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir } from "../../utils/fs.js";

// ── Types ────────────────────────────────────────────────────────────

/** Persisted token bundle at .bober/medical/whoop-token.json. */
export interface WhoopTokens {
  accessToken: string;
  refreshToken: string;
  expiresAtIso: string;
}

// ── WhoopTokenStore ──────────────────────────────────────────────────

/**
 * Manages WHOOP OAuth credentials and the 0600 refresh-token sidecar.
 *
 * clientCredentials() reads WHOOP_CLIENT_ID/WHOOP_CLIENT_SECRET from process.env —
 * mirroring src/providers/factory.ts:96-136 for the clear-throw pattern.
 *
 * readRefreshToken() / writeTokens() persist {accessToken, refreshToken, expiresAtIso}
 * at .bober/medical/whoop-token.json with mode 0600 — mirroring src/medical/consent.ts.
 *
 * NO network imports in this file (ADR-2); all HTTP lives in whoop-client.ts.
 *
 * bober: env-var creds + file sidecar; swap for OS keychain if per-user isolation
 *        is needed across multiple OS accounts (ADR-2 deferred).
 */
export class WhoopTokenStore {
  constructor(private readonly projectRoot: string) {}

  // ── Path ──────────────────────────────────────────────────────────

  private path(): string {
    return join(this.projectRoot, ".bober", "medical", "whoop-token.json");
  }

  // ── Credentials ───────────────────────────────────────────────────

  /**
   * Reads WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET from process.env.
   * Throws clearly naming both env vars when either is unset.
   */
  clientCredentials(): { clientId: string; clientSecret: string } {
    const clientId = process.env["WHOOP_CLIENT_ID"];
    const clientSecret = process.env["WHOOP_CLIENT_SECRET"];
    if (!clientId || !clientSecret) {
      throw new Error(
        "WHOOP credentials missing — set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET " +
          "environment variables and try again.",
      );
    }
    return { clientId, clientSecret };
  }

  // ── Token sidecar ─────────────────────────────────────────────────

  /**
   * Returns the stored refresh token, or undefined when the sidecar is absent or corrupt.
   * Fail-closed: any read/parse error => undefined (not yet authorised).
   */
  async readRefreshToken(): Promise<string | undefined> {
    try {
      const data = JSON.parse(
        await readFile(this.path(), "utf-8"),
      ) as Partial<WhoopTokens>;
      return typeof data.refreshToken === "string" ? data.refreshToken : undefined;
    } catch {
      return undefined; // absent or corrupt => not yet authorised
    }
  }

  /**
   * Persist token bundle at .bober/medical/whoop-token.json with mode 0600.
   * Directory is created if absent (mirrors consent.ts:75-81).
   */
  async writeTokens(tokens: WhoopTokens): Promise<void> {
    await ensureDir(join(this.projectRoot, ".bober", "medical"));
    await writeFile(
      this.path(),
      JSON.stringify(tokens, null, 2) + "\n",
      { encoding: "utf-8", mode: 0o600 },
    );
  }
}
