import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { SeoEgressGuard } from "../egress.js";
import { SeoQuotaGovernor } from "../quota-governor.js";
import type { BoberConfig } from "../../config/schema.js";
import type { HttpClient, HttpRequestInit, HttpResponse } from "../adapters/http.js";
import { GscAdapter } from "./gsc-adapter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEARCH_ANALYTICS_FIXTURE = new URL("../__fixtures__/gsc/search-analytics.json", import.meta.url);
const URL_INSPECTION_FIXTURE = new URL("../__fixtures__/gsc/url-inspection.json", import.meta.url);

const token = async () => "test-token";

/** One recorded outbound call — captured for both zero-network and body-shape assertions. */
type RecordedCall = { url: string; init: HttpRequestInit };

/** Records every call it receives and returns a canned response. Never opens a real socket. */
function spyHttp(body: unknown, ok = true, status = 200): { http: HttpClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const http: HttpClient = {
    async request(url, init): Promise<HttpResponse> {
      calls.push({ url, init });
      return { ok, status, json: async () => body };
    },
  };
  return { http, calls };
}

/** An http client that throws before ever returning — simulates a network failure. */
function throwingHttp(): HttpClient {
  return {
    request(): Promise<HttpResponse> {
      throw new Error("network unreachable");
    },
  };
}

/** Temp dirs created by `freshGovernor()` across the whole file — swept in the top-level `afterEach`. */
const tempDirs: string[] = [];

async function freshGovernor(maxUsd: number | null = null): Promise<SeoQuotaGovernor> {
  const dir = await mkdtemp(join(tmpdir(), "gsc-adapter-"));
  tempDirs.push(dir);
  return SeoQuotaGovernor.load(join(dir, "quota-ledger.json"), { seo: { budget: { maxUsd } } } as BoberConfig);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const query = {
  siteUrl: "https://example.com",
  startDate: "2026-06-01",
  endDate: "2026-06-30",
  dimensions: ["query"] as Array<"query" | "page" | "country" | "device">,
};

const inspection = { siteUrl: "https://example.com", inspectionUrl: "https://example.com/reviews" };

// -- sc-8-2: axis OFF -> abstain, ZERO network -----------------------------

describe("GscAdapter — egress axis OFF => abstain with zero network (sc-8-2)", () => {
  it("searchAnalytics: axis off resolves abstain and the http spy records 0 calls", async () => {
    const egress = new SeoEgressGuard(false, false); // search-console off
    const governor = await freshGovernor();
    const { http, calls } = spyHttp({ rows: [] });
    const adapter = new GscAdapter(egress, governor, http, token);

    const out = await adapter.searchAnalytics(query);
    expect(out).toEqual({ kind: "abstain", reason: "egress-search-console-disabled" });
    expect(calls).toHaveLength(0);
  });

  it("urlInspection: axis off resolves abstain and the http spy records 0 calls", async () => {
    const egress = new SeoEgressGuard(false, false);
    const governor = await freshGovernor();
    const { http, calls } = spyHttp({ inspectionResult: {} });
    const adapter = new GscAdapter(egress, governor, http, token);

    const out = await adapter.urlInspection(inspection);
    expect(out).toEqual({ kind: "abstain", reason: "egress-search-console-disabled" });
    expect(calls).toHaveLength(0);
  });
});

// -- sc-8-1 / stopCondition: axis ON + fixture -> typed data + provenance --

describe("GscAdapter — axis ON + fixture http client => typed data + provenance (sc-8-1)", () => {
  let egress: SeoEgressGuard;

  beforeEach(() => {
    egress = new SeoEgressGuard(true, false); // search-console on
  });

  it("searchAnalytics returns typed rows + provenance{source:'gsc'} and books actual rows via governor.record", async () => {
    const fixture = JSON.parse(await readFile(SEARCH_ANALYTICS_FIXTURE, "utf-8"));
    const governor = await freshGovernor();
    const { http, calls } = spyHttp(fixture);
    const adapter = new GscAdapter(egress, governor, http, token);

    const out = await adapter.searchAnalytics(query);
    expect(out.kind).toBe("data");
    if (out.kind !== "data") return;

    expect(out.rows).toHaveLength(3);
    expect(out.rows[0]).toEqual({
      query: "best online casino",
      clicks: 142,
      impressions: 3800,
      ctr: 0.0374,
      position: 4.2,
    });
    expect(out.provenance.source).toBe("gsc");
    expect(typeof out.provenance.retrievedAt).toBe("string");

    // Bearer token from the injected provider, never hardcoded.
    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers?.["Authorization"]).toBe("Bearer test-token");
    expect(calls[0].url).toContain("searchAnalytics/query");

    // governor.record was called with the ACTUAL row count (3), not the estimate.
    expect(governor.admit({ source: "gsc", capability: "search-analytics", scope: { siteUrl: query.siteUrl }, estRows: 50_000 - 3, estCostUsd: 0 }).admit).toBe(true);
    expect(governor.admit({ source: "gsc", capability: "search-analytics", scope: { siteUrl: query.siteUrl }, estRows: 50_000 - 2, estCostUsd: 0 }).admit).toBe(false);
  });

  it("urlInspection returns a single typed row + provenance and books 1 inspection via governor.record", async () => {
    const fixture = JSON.parse(await readFile(URL_INSPECTION_FIXTURE, "utf-8"));
    const governor = await freshGovernor();
    const { http, calls } = spyHttp(fixture);
    const adapter = new GscAdapter(egress, governor, http, token);

    const out = await adapter.urlInspection(inspection);
    expect(out.kind).toBe("data");
    if (out.kind !== "data") return;

    expect(out.rows).toEqual([
      {
        url: inspection.inspectionUrl,
        coverageState: "Submitted and indexed",
        indexingState: "INDEXING_ALLOWED",
        lastCrawlTime: "2026-07-14T03:12:00Z",
        robotsTxtState: "ALLOWED",
        pageFetchState: "SUCCESSFUL",
      },
    ]);
    expect(out.provenance.source).toBe("gsc");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect");

    // governor.record booked exactly 1 inspection against the 2,000/day cap.
    expect(
      governor.admit({ source: "gsc", capability: "url-inspection", scope: { siteUrl: inspection.siteUrl }, estRows: 1_999, estCostUsd: 0 }).admit,
    ).toBe(true);
    expect(
      governor.admit({ source: "gsc", capability: "url-inspection", scope: { siteUrl: inspection.siteUrl }, estRows: 2_000, estCostUsd: 0 }).admit,
    ).toBe(false);
  });
});

// -- sc-8-3: rowLimit cap + per-site scope threaded into the governor ------

describe("GscAdapter — rowLimit cap + governor scope threading (sc-8-3)", () => {
  it("caps a huge requested rowLimit at 25,000 in the outbound request body", async () => {
    const egress = new SeoEgressGuard(true, false);
    const governor = await freshGovernor();
    const { http, calls } = spyHttp({ rows: [] });
    const adapter = new GscAdapter(egress, governor, http, token);

    await adapter.searchAnalytics({ ...query, rowLimit: 999_999 });
    expect(calls).toHaveLength(1);
    const sentBody = JSON.parse(calls[0].init.body ?? "{}");
    expect(sentBody.rowLimit).toBe(25_000);
  });

  it("threads per-site scope into the governor: a different site is unaffected by a saturated site", async () => {
    const egress = new SeoEgressGuard(true, false);
    const governor = await freshGovernor();
    // Saturate the busy site's daily-rows ceiling directly via the governor.
    await governor.record(
      { source: "gsc", capability: "search-analytics", scope: { siteUrl: "https://busy.example" }, estRows: 50_000, estCostUsd: 0 },
      0,
    );
    const { http } = spyHttp({ rows: [] });
    const adapter = new GscAdapter(egress, governor, http, token);

    const busy = await adapter.searchAnalytics({ ...query, siteUrl: "https://busy.example" });
    expect(busy).toEqual({ kind: "abstain", reason: "daily-rows" });

    const quiet = await adapter.searchAnalytics({ ...query, siteUrl: "https://quiet.example" });
    expect(quiet.kind).toBe("data");
  });

  it("governor-refused request opens ZERO sockets", async () => {
    const egress = new SeoEgressGuard(true, false);
    const governor = await freshGovernor();
    await governor.record(
      { source: "gsc", capability: "search-analytics", scope: { siteUrl: query.siteUrl }, estRows: 50_000, estCostUsd: 0 },
      0,
    );
    const { http, calls } = spyHttp({ rows: [] });
    const adapter = new GscAdapter(egress, governor, http, token);

    const out = await adapter.searchAnalytics(query);
    expect(out).toEqual({ kind: "abstain", reason: "daily-rows" });
    expect(calls).toHaveLength(0);
  });
});

// -- sc-8-3: live HTTP/network error -> abstain, NEVER throw ---------------

describe("GscAdapter — HTTP/network errors degrade to abstain, never throw (sc-8-3)", () => {
  it("a 429 response resolves abstain (not throw)", async () => {
    const egress = new SeoEgressGuard(true, false);
    const governor = await freshGovernor();
    const { http } = spyHttp({}, false, 429);
    const adapter = new GscAdapter(egress, governor, http, token);

    await expect(adapter.searchAnalytics(query)).resolves.toEqual({ kind: "abstain", reason: "gsc-http-429" });
  });

  it("a 5xx response resolves abstain (not throw)", async () => {
    const egress = new SeoEgressGuard(true, false);
    const governor = await freshGovernor();
    const { http } = spyHttp({}, false, 503);
    const adapter = new GscAdapter(egress, governor, http, token);

    await expect(adapter.urlInspection(inspection)).resolves.toEqual({ kind: "abstain", reason: "gsc-http-503" });
  });

  it("a throwing http client resolves abstain{source-error} (not throw)", async () => {
    const egress = new SeoEgressGuard(true, false);
    const governor = await freshGovernor();
    const adapter = new GscAdapter(egress, governor, throwingHttp(), token);

    await expect(adapter.searchAnalytics(query)).resolves.toEqual({ kind: "abstain", reason: "source-error" });
    await expect(adapter.urlInspection(inspection)).resolves.toEqual({ kind: "abstain", reason: "source-error" });
  });
});

// -- sc-8-1: unsupported capabilities are always disabled -------------------

describe("GscAdapter — serp/keywords/backlinks are always disabled (sc-8-1)", () => {
  it("capabilities() advertises only search-analytics + url-inspection", async () => {
    const egress = new SeoEgressGuard(true, false);
    const governor = await freshGovernor();
    const adapter = new GscAdapter(egress, governor, spyHttp({}).http, token);
    expect(adapter.capabilities()).toEqual(["search-analytics", "url-inspection"]);
  });

  it("serp/keywords/backlinks resolve disabled regardless of axis state", async () => {
    for (const on of [true, false]) {
      const egress = new SeoEgressGuard(on, false);
      const governor = await freshGovernor();
      const { http, calls } = spyHttp({});
      const adapter = new GscAdapter(egress, governor, http, token);

      await expect(adapter.serp({ keyword: "x", location: "us" })).resolves.toEqual({ kind: "disabled" });
      await expect(adapter.keywords({ keywords: ["x"], location: "us" })).resolves.toEqual({ kind: "disabled" });
      await expect(adapter.backlinks({ target: "https://x.example" })).resolves.toEqual({ kind: "disabled" });
      expect(calls).toHaveLength(0);
    }
  });
});

// -- sc-8-4: the http import is confined to src/seo/adapters/ --------------

describe("GscAdapter — real fetch/http import confinement (sc-8-4)", () => {
  it("gsc-adapter.ts references no bare fetch(...) call and no node:http(s) import", async () => {
    const source = await readFile(join(HERE, "gsc-adapter.ts"), "utf-8");
    expect(/\bfetch\s*\(/.test(source)).toBe(false);
    expect(/from\s+["']node:https?["']/.test(source)).toBe(false);
  });

  it("every non-adapters, non-test file under src/seo/ is free of bare fetch(...) calls", async () => {
    const seoDir = join(HERE, "..");
    const offenders: string[] = [];
    await scanForFetch(seoDir, offenders);
    expect(offenders).toEqual([]);
  });
});

/** Recursively scan `dir` for `.ts` files (excluding `adapters/` and `*.test.ts`) that
 *  reference the bare `fetch(` global — the ADR-5 confinement invariant. */
async function scanForFetch(dir: string, offenders: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "adapters") continue; // the one sanctioned dir
      await scanForFetch(full, offenders);
      continue;
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    const text = await readFile(full, "utf-8");
    if (/\bfetch\s*\(/.test(text)) {
      offenders.push(full);
    }
  }
}
