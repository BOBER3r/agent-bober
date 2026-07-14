/**
 * WhoopClient — the SECOND ESLint-excepted network file (ADR-1, sibling to medline-source.ts).
 * All WHOOP HTTP access lives here and NOWHERE ELSE under src/medical.
 *
 * assertAllowed("device-connection") is called BEFORE any fetch attempt — runtime
 * defense-in-depth backing the static ESLint boundary (mirrors medline-source.ts).
 *
 * bober: single OAuth2 refresh_token grant + v2 paginated GET; add webhook/push support
 *        only if WHOOP public API exposes a server-push option (currently pull-only, ADR-1).
 */
import type { EgressGuard } from "../egress.js";
import type { WhoopTokenStore, WhoopTokens } from "./whoop-token.js";

// ── Types ────────────────────────────────────────────────────────────

/** The four WHOOP data collections available via v2 endpoints. */
export type WhoopCollection = "recovery" | "sleep" | "cycle" | "workout";

/** ISO-8601 time window for a paginated fetch request. */
export type SyncWindow = { startIso: string; endIso: string };

/** A single WHOOP record as normalised for downstream processing. */
export type WhoopRecord = {
  id: string;
  tStartIso: string;
  tEndIso?: string;
  metrics: Record<string, number>;
};

/** One page of WHOOP records; nextCursor undefined means this is the last page. */
export type WhoopPage = { records: WhoopRecord[]; nextCursor?: string };

/**
 * Injectable transport type — extended vs. the MedlineSource FetchLike to add:
 *   - `init` arg: method, headers, body for POST refresh grant + authorised GET
 *   - `headers.get(name)`: needed for 429 X-RateLimit-Reset header reading
 *
 * Tests pass a duck-typed fake returning fixture data; production defaults to global fetch.
 */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

// ── Module constants ─────────────────────────────────────────────────

const WHOOP_API_BASE = "https://api.prod.whoop.com";
const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token";

/** Maps each WhoopCollection to its WHOOP v2 API path. */
const COLLECTION_PATHS: Record<WhoopCollection, string> = {
  recovery: "/v2/recovery",
  sleep: "/v2/activity/sleep",
  cycle: "/v2/cycle",
  workout: "/v2/activity/workout",
};

// ── Response parsers ─────────────────────────────────────────────────

/**
 * Parse a WHOOP v2 paginated response body into a WhoopPage.
 * Returns empty records on any structural mismatch (fail-safe read).
 */
function parseWhoopPage(raw: unknown): WhoopPage {
  if (!raw || typeof raw !== "object") return { records: [] };

  const body = raw as Record<string, unknown>;

  const records: WhoopRecord[] = [];
  const dataArr = body["records"];
  if (Array.isArray(dataArr)) {
    for (const item of dataArr) {
      if (!item || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      const id = typeof r["id"] === "number" ? String(r["id"]) : (typeof r["id"] === "string" ? r["id"] : "");
      const tStartIso = typeof r["start"] === "string" ? r["start"] : "";
      const tEndIso = typeof r["end"] === "string" ? r["end"] : undefined;
      const score = r["score"];
      const metrics: Record<string, number> = {};
      if (score && typeof score === "object") {
        for (const [k, v] of Object.entries(score as Record<string, unknown>)) {
          if (typeof v === "number") metrics[k] = v;
        }
      }
      if (id) records.push({ id, tStartIso, tEndIso, metrics });
    }
  }

  const nextCursor =
    typeof body["next_token"] === "string" ? body["next_token"] : undefined;

  return { records, nextCursor };
}

/**
 * Parse a WHOOP OAuth token response body.
 * Returns null on any structural mismatch.
 */
function parseTokenResponse(raw: unknown): {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const accessToken = r["access_token"];
  const refreshToken = r["refresh_token"];
  const expiresIn = r["expires_in"];
  if (
    typeof accessToken !== "string" ||
    typeof refreshToken !== "string" ||
    typeof expiresIn !== "number"
  ) {
    return null;
  }
  return { accessToken, refreshToken, expiresIn };
}

// ── WhoopClient ──────────────────────────────────────────────────────

/**
 * Authenticated WHOOP v2 API client.
 *
 * This is the SECOND ESLint-excepted network file (ADR-1). All WHOOP HTTP
 * access — the OAuth2 refresh_token grant and all v2 paginated GETs — lives
 * HERE and nowhere else under src/medical.
 *
 * Design invariants:
 * - ensureAccessToken and fetchPage BOTH start with assertAllowed("device-connection").
 *   With the axis off, both methods throw before any fetchImpl call (sc-2-4).
 * - 401 triggers exactly ONE refresh+retry; a second 401 throws (no infinite loop).
 * - 429 reads the X-RateLimit-Reset header (seconds), awaits the INJECTED waiter,
 *   then retries; the waiter is injectable so tests never actually sleep (sc-2-7).
 * - Timestamps are never derived from Date.now(); nowIso is injected for testability.
 *
 * bober: single-process access token cache (in-memory); swap for a shared cache
 *        (Redis / SQLite) if multi-process token sharing is needed.
 */
export class WhoopClient {
  private cached?: { accessToken: string; expiresAtIso: string };

  constructor(
    private readonly egress: EgressGuard,
    private readonly tokenStore: WhoopTokenStore,
    // bober: global fetch is the default ONLY in this file (ESLint exception);
    //        tests inject a FetchLike returning fixture data so CI stays offline.
    private readonly fetchImpl: FetchLike = fetch as FetchLike,
    // bober: waiter defaults to real setTimeout; tests inject a no-wait recording waiter
    //        so 429-Reset handling is assertable without sleeping (Pattern 3).
    private readonly waiter: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
    // bober: nowIso is injected for token expiry comparisons; tests pass a fixed string;
    //        production callers pass new Date().toISOString() — never Date.now() internally.
    private readonly nowIso: () => string = () => new Date().toISOString(),
  ) {}

  // ── ensureAccessToken ─────────────────────────────────────────────

  /**
   * Returns a valid WHOOP access token, refreshing if the cached token is expired.
   *
   * Order:
   * 1. assertAllowed("device-connection") — throws if axis is off (sc-2-4).
   * 2. If cached and unexpired, return cached access token.
   * 3. Read refresh token from tokenStore; throw "authorize-first" if absent.
   * 4. POST refresh_token grant to WHOOP_TOKEN_URL via fetchImpl.
   * 5. Persist rotated tokens via tokenStore.writeTokens.
   * 6. Cache and return the new access token.
   *
   * On 401/invalid_grant from the token endpoint, throws a clear "re-authorize" error.
   */
  async ensureAccessToken(): Promise<string> {
    this.egress.assertAllowed("device-connection"); // MUST be first (sc-2-4)

    // Return cached token if still valid
    if (this.cached && this.cached.expiresAtIso > this.nowIso()) {
      return this.cached.accessToken;
    }

    return this._doRefresh();
  }

  /** Performs the OAuth2 refresh_token grant and caches the new tokens. */
  private async _doRefresh(): Promise<string> {
    const refreshToken = await this.tokenStore.readRefreshToken();
    if (!refreshToken) {
      throw new Error(
        "WHOOP not yet authorised — run `bober medical whoop authorize` first.",
      );
    }

    const { clientId, clientSecret } = this.tokenStore.clientCredentials();

    // Build form body manually — URLSearchParams is not declared in the ESLint globals config.
    const body = [
      `grant_type=refresh_token`,
      `refresh_token=${encodeURIComponent(refreshToken)}`,
      `client_id=${encodeURIComponent(clientId)}`,
      `client_secret=${encodeURIComponent(clientSecret)}`,
      `scope=offline`,
    ].join("&");

    const res = await this.fetchImpl(WHOOP_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    if (!res.ok || res.status === 401) {
      throw new Error(
        "WHOOP token refresh failed (401/invalid_grant) — re-authorize with " +
          "`bober medical whoop authorize`.",
      );
    }

    const raw = await res.json();
    const parsed = parseTokenResponse(raw);
    if (!parsed) {
      throw new Error("WHOOP token endpoint returned an unexpected response shape.");
    }

    // Compute expiry ISO from expires_in (seconds); use injected nowIso as baseline
    const expiresAtMs =
      new Date(this.nowIso()).getTime() + parsed.expiresIn * 1000;
    const expiresAtIso = new Date(expiresAtMs).toISOString();

    const tokens: WhoopTokens = {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAtIso,
    };
    await this.tokenStore.writeTokens(tokens);

    this.cached = { accessToken: parsed.accessToken, expiresAtIso };
    return parsed.accessToken;
  }

  // ── fetchPage ─────────────────────────────────────────────────────

  /**
   * Fetch one page of WHOOP v2 data for the given collection and time window.
   *
   * Order:
   * 1. assertAllowed("device-connection") — throws if axis is off (sc-2-4).
   * 2. ensureAccessToken — gets/refreshes the Bearer token.
   * 3. GET WHOOP_API_BASE + COLLECTION_PATHS[collection] with query params.
   * 4. On 401: call ensureAccessToken (force refresh) and retry EXACTLY ONCE.
   * 5. On 429: read X-RateLimit-Reset header (seconds), await waiter, retry.
   * 6. Parse JSON into WhoopPage.
   *
   * Throws on non-recoverable errors (5xx, second 401, network failure, etc.).
   *
   * @param collection - The WHOOP data collection to fetch.
   * @param window     - The ISO-8601 time window for filtering records.
   * @param cursor     - Pagination cursor from the previous page's nextCursor.
   */
  async fetchPage(
    collection: WhoopCollection,
    window: SyncWindow,
    cursor?: string,
  ): Promise<WhoopPage> {
    this.egress.assertAllowed("device-connection"); // MUST be first (sc-2-4)

    const accessToken = await this.ensureAccessToken();
    return this._doFetch(collection, window, cursor, accessToken, false);
  }

  /** Inner GET with single 401-refresh-retry and single 429-Reset-wait. */
  private async _doFetch(
    collection: WhoopCollection,
    window: SyncWindow,
    cursor: string | undefined,
    accessToken: string,
    isRetry: boolean,
  ): Promise<WhoopPage> {
    const path = COLLECTION_PATHS[collection];
    // Build query string manually — URLSearchParams is not declared in the ESLint globals config.
    const qs =
      `start=${encodeURIComponent(window.startIso)}&end=${encodeURIComponent(window.endIso)}` +
      (cursor !== undefined ? `&nextToken=${encodeURIComponent(cursor)}` : "");
    const url = `${WHOOP_API_BASE}${path}?${qs}`;

    const res = await this.fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (res.status === 401) {
      if (isRetry) {
        throw new Error(
          "WHOOP returned 401 after token refresh — re-authorize with " +
            "`bober medical whoop authorize`.",
        );
      }
      // Force a fresh token and retry exactly once
      this.cached = undefined;
      const freshToken = await this._doRefresh();
      return this._doFetch(collection, window, cursor, freshToken, true);
    }

    if (res.status === 429) {
      const resetHeader = res.headers.get("X-RateLimit-Reset");
      const resetSeconds = resetHeader !== null ? Number(resetHeader) : 60;
      await this.waiter(resetSeconds * 1000);
      // Retry after waiting — use same access token (rate limit, not auth failure)
      return this._doFetch(collection, window, cursor, accessToken, isRetry);
    }

    if (!res.ok) {
      throw new Error(
        `WHOOP API error: HTTP ${res.status} fetching ${collection}`,
      );
    }

    const raw = await res.json();
    return parseWhoopPage(raw);
  }
}
