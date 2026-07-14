/**
 * WhoopClient tests — fixture-driven; no real network, no real sleeping.
 *
 * Tests inject FetchLike fakes and a recording waiter. The global fetch is
 * NEVER called (banned in test files under src/medical by the ESLint boundary).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EgressGuard } from "../egress.js";
import { WhoopTokenStore } from "./whoop-token.js";
import { WhoopClient, type FetchLike, type WhoopCollection } from "./whoop-client.js";

// ── Helpers — recording waiter ────────────────────────────────────────

function recordingWaiter() {
  const waited: number[] = [];
  return {
    waited,
    wait: (ms: number): Promise<void> => {
      waited.push(ms);
      return Promise.resolve();
    },
  };
}

// ── Helpers — FetchLike fixtures ──────────────────────────────────────

function makeResponse(
  body: unknown,
  opts: { ok?: boolean; status?: number; reset?: string } = {},
) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: {
      get: (n: string) =>
        n === "X-RateLimit-Reset" ? (opts.reset ?? null) : null,
    },
    json: async () => body,
  };
}

/** Queue-based stateful fake: returns responses[i] on the i-th call. */
function makeQueueFetch(
  responses: ReturnType<typeof makeResponse>[],
): FetchLike {
  let i = 0;
  return async () =>
    responses[Math.min(i++, responses.length - 1)]!;
}

// ── Valid token response fixture ──────────────────────────────────────

const tokenResponseBody = {
  access_token: "fresh-access",
  refresh_token: "new-refresh",
  expires_in: 3600,
};

// ── Page response fixtures ────────────────────────────────────────────

function makePageBody(records: unknown[], nextToken?: string) {
  const body: Record<string, unknown> = { records };
  if (nextToken !== undefined) body["next_token"] = nextToken;
  return body;
}

const record1 = { id: 1, start: "2026-06-16T08:00:00Z", end: "2026-06-16T09:00:00Z", score: { recovery_score: 85 } };
const record2 = { id: 2, start: "2026-06-16T09:00:00Z", end: "2026-06-16T10:00:00Z", score: { recovery_score: 90 } };

// ── Temp dir + token store lifecycle ─────────────────────────────────

let tmpDir: string;
let tokenStore: WhoopTokenStore;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-whoop-client-"));
  tokenStore = new WhoopTokenStore(tmpDir);
  // Pre-seed env + refresh token so auth flow can run
  process.env["WHOOP_CLIENT_ID"] = "test-client-id";
  process.env["WHOOP_CLIENT_SECRET"] = "test-client-secret";
  await tokenStore.writeTokens({
    accessToken: "old-access",
    refreshToken: "stored-refresh",
    expiresAtIso: "2020-01-01T00:00:00.000Z", // expired
  });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  delete process.env["WHOOP_CLIENT_ID"];
  delete process.env["WHOOP_CLIENT_SECRET"];
});

// ── sc-2-4: axis OFF — both methods throw, fetchImpl never called ─────

describe("WhoopClient — axis off: throws before fetchImpl (sc-2-4)", () => {
  it("ensureAccessToken throws 'device-connection not enabled' and fetch spy records 0 calls", async () => {
    const egress = new EgressGuard(false, false, false); // all axes off
    const calls: string[] = [];
    const spyFetch: FetchLike = async (url) => {
      calls.push(url);
      return makeResponse({});
    };
    const client = new WhoopClient(egress, tokenStore, spyFetch);

    await expect(client.ensureAccessToken()).rejects.toThrow(/device-connection/);
    expect(calls).toHaveLength(0);
  });

  it("fetchPage throws 'device-connection not enabled' and fetch spy records 0 calls", async () => {
    const egress = new EgressGuard(false, false, false);
    const calls: string[] = [];
    const spyFetch: FetchLike = async (url) => {
      calls.push(url);
      return makeResponse({});
    };
    const client = new WhoopClient(egress, tokenStore, spyFetch);

    await expect(
      client.fetchPage("recovery", { startIso: "2026-06-16T00:00:00Z", endIso: "2026-06-17T00:00:00Z" }),
    ).rejects.toThrow(/device-connection/);
    expect(calls).toHaveLength(0);
  });
});

// ── sc-2-7: cursor pagination ─────────────────────────────────────────

describe("WhoopClient.fetchPage — cursor pagination (sc-2-7)", () => {
  it("fetches first page with nextCursor when server returns next_token", async () => {
    const egress = new EgressGuard(false, false, true); // device-connection on
    // First call: token refresh (POST), second call: page fetch (GET with page body)
    const fetchImpl = makeQueueFetch([
      makeResponse(tokenResponseBody), // token refresh
      makeResponse(makePageBody([record1], "cursor-page2")), // page 1
    ]);
    const client = new WhoopClient(
      egress,
      tokenStore,
      fetchImpl,
      recordingWaiter().wait,
      () => "2026-06-17T00:00:00.000Z",
    );

    const page = await client.fetchPage("recovery", {
      startIso: "2026-06-16T00:00:00Z",
      endIso: "2026-06-17T00:00:00Z",
    });

    expect(page.records).toHaveLength(1);
    expect(page.records[0]?.id).toBe("1");
    expect(page.nextCursor).toBe("cursor-page2");
  });

  it("fetches second page using cursor; last page has no nextCursor", async () => {
    const egress = new EgressGuard(false, false, true);
    const fetchImpl = makeQueueFetch([
      makeResponse(tokenResponseBody), // token refresh
      makeResponse(makePageBody([record2])), // page 2 (no next_token)
    ]);
    const client = new WhoopClient(
      egress,
      tokenStore,
      fetchImpl,
      recordingWaiter().wait,
      () => "2026-06-17T00:00:00.000Z",
    );

    const page = await client.fetchPage(
      "recovery",
      { startIso: "2026-06-16T00:00:00Z", endIso: "2026-06-17T00:00:00Z" },
      "cursor-page2",
    );

    expect(page.records).toHaveLength(1);
    expect(page.records[0]?.id).toBe("2");
    expect(page.nextCursor).toBeUndefined();
  });

  it("walks two pages end-to-end using returned cursor", async () => {
    const egress = new EgressGuard(false, false, true);
    // token refresh, page1, token refresh (cached), page2
    // Since token is cached after first refresh, only first call is a token refresh
    // and the two page fetches follow
    const fetchImpl = makeQueueFetch([
      makeResponse(tokenResponseBody),                          // token refresh
      makeResponse(makePageBody([record1], "cursor-page2")),   // page 1
      makeResponse(makePageBody([record2])),                    // page 2
    ]);
    const client = new WhoopClient(
      egress,
      tokenStore,
      fetchImpl,
      recordingWaiter().wait,
      () => "2026-06-17T00:00:00.000Z",
    );

    const window = { startIso: "2026-06-16T00:00:00Z", endIso: "2026-06-17T00:00:00Z" };

    // Fetch page 1
    const page1 = await client.fetchPage("recovery", window);
    expect(page1.records).toHaveLength(1);
    expect(page1.nextCursor).toBe("cursor-page2");

    // Fetch page 2 using the cursor from page 1
    const page2 = await client.fetchPage("recovery", window, page1.nextCursor);
    expect(page2.records).toHaveLength(1);
    expect(page2.nextCursor).toBeUndefined();
  });
});

// ── sc-2-7: 401 → refresh + retry exactly once ───────────────────────

describe("WhoopClient.fetchPage — 401 refresh + retry once (sc-2-7)", () => {
  it("on 401, refreshes access token and retries exactly once, then succeeds", async () => {
    const egress = new EgressGuard(false, false, true);
    const callLog: string[] = [];

    const fetchImpl = makeQueueFetch([
      makeResponse(tokenResponseBody),                     // initial token refresh (expired seed)
      makeResponse(null, { ok: false, status: 401 }),     // first GET → 401
      makeResponse(tokenResponseBody),                     // refresh after 401
      makeResponse(makePageBody([record1])),               // retry GET → 200
    ]);

    const trackingFetch: FetchLike = async (url, init) => {
      callLog.push(`${init?.method ?? "GET"} ${url}`);
      return fetchImpl(url, init);
    };

    const client = new WhoopClient(
      egress,
      tokenStore,
      trackingFetch,
      recordingWaiter().wait,
      () => "2026-06-17T00:00:00.000Z",
    );

    const page = await client.fetchPage("recovery", {
      startIso: "2026-06-16T00:00:00Z",
      endIso: "2026-06-17T00:00:00Z",
    });

    expect(page.records).toHaveLength(1);
    // Exactly one refresh POST before the 401 GET, one refresh POST after, one retry GET
    const postCalls = callLog.filter((c) => c.startsWith("POST"));
    expect(postCalls).toHaveLength(2); // initial expired token refresh + post-401 refresh
    const getCalls = callLog.filter((c) => c.startsWith("GET"));
    expect(getCalls).toHaveLength(2); // first attempt (401) + retry (200)
  });

  it("on second 401 after refresh, throws re-authorize error", async () => {
    const egress = new EgressGuard(false, false, true);

    const fetchImpl = makeQueueFetch([
      makeResponse(tokenResponseBody),                      // initial token refresh
      makeResponse(null, { ok: false, status: 401 }),      // first GET → 401
      makeResponse(tokenResponseBody),                      // refresh after 401
      makeResponse(null, { ok: false, status: 401 }),      // retry GET → 401 again
    ]);

    const client = new WhoopClient(
      egress,
      tokenStore,
      fetchImpl,
      recordingWaiter().wait,
      () => "2026-06-17T00:00:00.000Z",
    );

    await expect(
      client.fetchPage("recovery", { startIso: "2026-06-16T00:00:00Z", endIso: "2026-06-17T00:00:00Z" }),
    ).rejects.toThrow(/re-authorize/);
  });
});

// ── sc-2-7: 429 → read Reset header, inject waiter, retry ────────────

describe("WhoopClient.fetchPage — 429 rate limit (sc-2-7)", () => {
  it("on 429, invokes injected waiter with Reset-header seconds * 1000, then retries", async () => {
    const egress = new EgressGuard(false, false, true);
    const { waited, wait } = recordingWaiter();

    const fetchImpl = makeQueueFetch([
      makeResponse(tokenResponseBody),                                         // token refresh
      makeResponse(null, { ok: false, status: 429, reset: "2" }),            // 429 with Reset: 2s
      makeResponse(makePageBody([record1])),                                   // retry → 200
    ]);

    const client = new WhoopClient(
      egress,
      tokenStore,
      fetchImpl,
      wait,
      () => "2026-06-17T00:00:00.000Z",
    );

    const page = await client.fetchPage("recovery", {
      startIso: "2026-06-16T00:00:00Z",
      endIso: "2026-06-17T00:00:00Z",
    });

    expect(page.records).toHaveLength(1);
    expect(waited).toHaveLength(1);
    expect(waited[0]).toBe(2000); // 2 seconds → 2000 ms
  });

  it("429 with no Reset header defaults to 60s wait (60000 ms)", async () => {
    const egress = new EgressGuard(false, false, true);
    const { waited, wait } = recordingWaiter();

    const fetchImpl = makeQueueFetch([
      makeResponse(tokenResponseBody),                         // token refresh
      makeResponse(null, { ok: false, status: 429 }),        // 429, no reset header
      makeResponse(makePageBody([record2])),                   // retry → 200
    ]);

    const client = new WhoopClient(
      egress,
      tokenStore,
      fetchImpl,
      wait,
      () => "2026-06-17T00:00:00.000Z",
    );

    await client.fetchPage("recovery", {
      startIso: "2026-06-16T00:00:00Z",
      endIso: "2026-06-17T00:00:00Z",
    });

    expect(waited[0]).toBe(60000); // default 60s
  });
});

// ── sc-2-7: collection paths ──────────────────────────────────────────

describe("WhoopClient — collection path routing (sc-2-7)", () => {
  const collections: Array<[WhoopCollection, string]> = [
    ["recovery", "/v2/recovery"],
    ["sleep", "/v2/activity/sleep"],
    ["cycle", "/v2/cycle"],
    ["workout", "/v2/activity/workout"],
  ];

  for (const [collection, expectedPath] of collections) {
    it(`routes '${collection}' to '${expectedPath}'`, async () => {
      const egress = new EgressGuard(false, false, true);
      const urls: string[] = [];

      const fetchImpl: FetchLike = async (url, init) => {
        urls.push(url);
        // First call is POST (token refresh), subsequent are GET (data fetch)
        if (init?.method === "POST") {
          return makeResponse(tokenResponseBody);
        }
        return makeResponse(makePageBody([]));
      };

      const client = new WhoopClient(
        egress,
        tokenStore,
        fetchImpl,
        recordingWaiter().wait,
        () => "2026-06-17T00:00:00.000Z",
      );

      await client.fetchPage(collection, {
        startIso: "2026-06-16T00:00:00Z",
        endIso: "2026-06-17T00:00:00Z",
      });

      const getUrl = urls.find((u) => u.includes(expectedPath));
      expect(getUrl).toBeDefined();
    });
  }
});
