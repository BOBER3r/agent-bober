import { describe, it, expect, afterEach } from "vitest";
import { readFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { SeoEgressGuard } from "../egress.js";
import { SeoQuotaGovernor } from "../quota-governor.js";
import type { BoberConfig } from "../../config/schema.js";
import type { HttpClient, HttpRequestInit, HttpResponse } from "../adapters/http.js";
import { DataForSeoAdapter } from "./dataforseo-adapter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERP_FIXTURE = new URL("../__fixtures__/dataforseo/serp.json", import.meta.url);
const KEYWORDS_FIXTURE = new URL("../__fixtures__/dataforseo/keywords.json", import.meta.url);
const BACKLINKS_FIXTURE = new URL("../__fixtures__/dataforseo/backlinks.json", import.meta.url);

const auth = async () => "dGVzdDp0ZXN0";

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
  const dir = await mkdtemp(join(tmpdir(), "dataforseo-adapter-"));
  tempDirs.push(dir);
  return SeoQuotaGovernor.load(join(dir, "quota-ledger.json"), { seo: { budget: { maxUsd } } } as BoberConfig);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const serpQuery = { keyword: "best casino", location: "United States", priority: "standard" as const };
const keywordQuery = { keywords: ["best online casino", "crypto casino no kyc"], location: "United States" };
const backlinkQuery = { target: "https://target.example/page", limit: 10 };

// -- sc-9-2: axis OFF -> abstain, ZERO network, ZERO booking ----------------

describe("DataForSeoAdapter — egress axis OFF => abstain with zero network + zero booking (sc-9-2)", () => {
  it("serp: axis off resolves abstain, the http spy records 0 calls, and spentUsd is unchanged", async () => {
    const egress = new SeoEgressGuard(false, false); // serp-provider off
    const governor = await freshGovernor();
    const { http, calls } = spyHttp({ tasks: [] });
    const adapter = new DataForSeoAdapter(egress, governor, http, auth);

    const out = await adapter.serp(serpQuery);
    expect(out).toEqual({ kind: "abstain", reason: "egress-serp-provider-disabled" });
    expect(calls).toHaveLength(0);
    expect(governor.spentUsd()).toBe(0);
  });

  it("keywords: axis off resolves abstain, the http spy records 0 calls, and spentUsd is unchanged", async () => {
    const egress = new SeoEgressGuard(false, false);
    const governor = await freshGovernor();
    const { http, calls } = spyHttp({ tasks: [] });
    const adapter = new DataForSeoAdapter(egress, governor, http, auth);

    const out = await adapter.keywords(keywordQuery);
    expect(out).toEqual({ kind: "abstain", reason: "egress-serp-provider-disabled" });
    expect(calls).toHaveLength(0);
    expect(governor.spentUsd()).toBe(0);
  });

  it("backlinks: axis off resolves abstain, the http spy records 0 calls, and spentUsd is unchanged", async () => {
    const egress = new SeoEgressGuard(false, false);
    const governor = await freshGovernor();
    const { http, calls } = spyHttp({ tasks: [] });
    const adapter = new DataForSeoAdapter(egress, governor, http, auth);

    const out = await adapter.backlinks(backlinkQuery);
    expect(out).toEqual({ kind: "abstain", reason: "egress-serp-provider-disabled" });
    expect(calls).toHaveLength(0);
    expect(governor.spentUsd()).toBe(0);
  });

  it("axis off with search-console ON but serp-provider off still abstains (axes are independent)", async () => {
    const egress = new SeoEgressGuard(true, false); // search-console on, serp-provider off
    const governor = await freshGovernor();
    const { http, calls } = spyHttp({ tasks: [] });
    const adapter = new DataForSeoAdapter(egress, governor, http, auth);

    const out = await adapter.serp(serpQuery);
    expect(out).toEqual({ kind: "abstain", reason: "egress-serp-provider-disabled" });
    expect(calls).toHaveLength(0);
  });
});

// -- sc-9-1 / sc-9-3 / sc-9-4: axis ON + fixture -> typed data + costed provenance --

describe("DataForSeoAdapter — axis ON + fixture http client => typed data + USD booking (sc-9-1, sc-9-3, sc-9-4)", () => {
  it("serp returns typed rows + provenance{source:'dataforseo', costUsd} and books $0.0006 via governor.record", async () => {
    const egress = new SeoEgressGuard(false, true); // serp-provider ON (2nd arg!)
    const governor = await freshGovernor(1); // $1 cap
    const fixture = JSON.parse(await readFile(SERP_FIXTURE, "utf-8"));
    const { http, calls } = spyHttp(fixture);
    const adapter = new DataForSeoAdapter(egress, governor, http, auth);

    const out = await adapter.serp(serpQuery);
    expect(out.kind).toBe("data");
    if (out.kind !== "data") return;

    expect(out.rows).toEqual([
      { keyword: "best casino", position: 1, url: "https://a.example/best-casino", title: "Best Casino", location: "United States" },
      { keyword: "best casino", position: 2, url: "https://b.example/top-slots", title: "Top Slots", location: "United States" },
    ]);
    expect(out.provenance.source).toBe("dataforseo");
    expect(typeof out.provenance.retrievedAt).toBe("string");
    expect(out.provenance.costUsd).toBeCloseTo(0.0006, 6);

    // Basic auth header from the injected credential provider, never hardcoded.
    expect(calls).toHaveLength(1);
    expect(calls[0].init.headers?.["Authorization"]).toBe("Basic dGVzdDp0ZXN0");
    expect(calls[0].url).toContain("api.dataforseo.com/v3/serp");

    // governor.record() booked the USD — spentUsd advanced by exactly $0.0006.
    expect(governor.spentUsd()).toBeCloseTo(0.0006, 6);
  });

  it("serp priority='live' books the $0.002 live price, not the standard price", async () => {
    const egress = new SeoEgressGuard(false, true);
    const governor = await freshGovernor(1);
    const fixture = JSON.parse(await readFile(SERP_FIXTURE, "utf-8"));
    const { http } = spyHttp(fixture);
    const adapter = new DataForSeoAdapter(egress, governor, http, auth);

    const out = await adapter.serp({ ...serpQuery, priority: "live" });
    expect(out.kind).toBe("data");
    if (out.kind !== "data") return;
    expect(out.provenance.costUsd).toBeCloseTo(0.002, 6);
    expect(governor.spentUsd()).toBeCloseTo(0.002, 6);
  });

  it("keywords returns typed rows + provenance{costUsd} and books the keywords task price", async () => {
    const egress = new SeoEgressGuard(false, true);
    const governor = await freshGovernor(1);
    const fixture = JSON.parse(await readFile(KEYWORDS_FIXTURE, "utf-8"));
    const { http, calls } = spyHttp(fixture);
    const adapter = new DataForSeoAdapter(egress, governor, http, auth);

    const out = await adapter.keywords(keywordQuery);
    expect(out.kind).toBe("data");
    if (out.kind !== "data") return;

    expect(out.rows).toEqual([
      { keyword: "best online casino", location: "United States", searchVolume: 40500, cpc: 3.21, competition: 0.89 },
      { keyword: "crypto casino no kyc", location: "United States", searchVolume: 2900, cpc: 1.75, competition: 0.62 },
    ]);
    expect(out.provenance.source).toBe("dataforseo");
    expect(out.provenance.costUsd).toBeCloseTo(0.0006, 6);
    expect(calls[0].url).toContain("api.dataforseo.com/v3/dataforseo_labs");
    expect(governor.spentUsd()).toBeCloseTo(0.0006, 6);
  });

  it("backlinks returns typed rows + provenance{costUsd} priced $0.02 base + $0.00003/row (sc-9-3 per-row cost)", async () => {
    const egress = new SeoEgressGuard(false, true);
    const governor = await freshGovernor(1);
    const fixture = JSON.parse(await readFile(BACKLINKS_FIXTURE, "utf-8"));
    const { http, calls } = spyHttp(fixture);
    const adapter = new DataForSeoAdapter(egress, governor, http, auth);

    const out = await adapter.backlinks(backlinkQuery);
    expect(out.kind).toBe("data");
    if (out.kind !== "data") return;

    expect(out.rows).toHaveLength(3);
    expect(out.rows[0]).toEqual({
      sourceUrl: "https://ref1.example/article",
      targetUrl: "https://target.example/page",
      anchor: "best casino guide",
      dofollow: true,
    });
    const expectedCost = 0.02 + 3 * 0.00003;
    expect(out.provenance.costUsd).toBeCloseTo(expectedCost, 8);
    expect(calls[0].url).toContain("api.dataforseo.com/v3/backlinks");
    expect(governor.spentUsd()).toBeCloseTo(expectedCost, 8);
  });
});

// -- sc-9-2: budget-exceeded admit opens ZERO sockets ------------------------

describe("DataForSeoAdapter — budget-exceeded admit opens ZERO sockets (sc-9-2)", () => {
  it("a cap below the standard SERP price refuses admission before any http call", async () => {
    const egress = new SeoEgressGuard(false, true);
    const governor = await freshGovernor(0.0005); // cap BELOW the $0.0006 standard price
    const fixture = JSON.parse(await readFile(SERP_FIXTURE, "utf-8"));
    const { http, calls } = spyHttp(fixture);
    const adapter = new DataForSeoAdapter(egress, governor, http, auth);

    const out = await adapter.serp(serpQuery);
    expect(out).toEqual({ kind: "abstain", reason: "budget-exceeded" });
    expect(calls).toHaveLength(0); // admit refused before any socket
    expect(governor.spentUsd()).toBe(0);
  });

  it("an already-saturated budget refuses backlinks admission with zero sockets", async () => {
    const egress = new SeoEgressGuard(false, true);
    const governor = await freshGovernor(0.02); // cap too low for base $0.02 + per-row worst case
    const { http, calls } = spyHttp({ tasks: [] });
    const adapter = new DataForSeoAdapter(egress, governor, http, auth);

    const out = await adapter.backlinks(backlinkQuery); // limit: 10 -> worst-case 0.02 + 10*0.00003 > 0.02 cap
    expect(out).toEqual({ kind: "abstain", reason: "budget-exceeded" });
    expect(calls).toHaveLength(0);
    expect(governor.spentUsd()).toBe(0);
  });
});

// -- sc-9-3: HTTP/network errors degrade to abstain, NEVER throw, NOTHING booked --

describe("DataForSeoAdapter — HTTP/network errors degrade to abstain, never throw, nothing booked (sc-9-3)", () => {
  it("a 402 insufficient-balance response resolves abstain (not throw) and books nothing", async () => {
    const egress = new SeoEgressGuard(false, true);
    const governor = await freshGovernor();
    const { http } = spyHttp({}, false, 402);
    const adapter = new DataForSeoAdapter(egress, governor, http, auth);

    await expect(adapter.serp(serpQuery)).resolves.toEqual({ kind: "abstain", reason: "dataforseo-http-402" });
    expect(governor.spentUsd()).toBe(0);
  });

  it("a 429 rate-limited response resolves abstain (not throw) and books nothing", async () => {
    const egress = new SeoEgressGuard(false, true);
    const governor = await freshGovernor();
    const { http } = spyHttp({}, false, 429);
    const adapter = new DataForSeoAdapter(egress, governor, http, auth);

    await expect(adapter.keywords(keywordQuery)).resolves.toEqual({ kind: "abstain", reason: "dataforseo-http-429" });
    expect(governor.spentUsd()).toBe(0);
  });

  it("a 5xx response resolves abstain (not throw) and books nothing", async () => {
    const egress = new SeoEgressGuard(false, true);
    const governor = await freshGovernor();
    const { http } = spyHttp({}, false, 503);
    const adapter = new DataForSeoAdapter(egress, governor, http, auth);

    await expect(adapter.backlinks(backlinkQuery)).resolves.toEqual({ kind: "abstain", reason: "dataforseo-http-503" });
    expect(governor.spentUsd()).toBe(0);
  });

  it("a throwing http client resolves abstain{source-error} (not throw) and books nothing", async () => {
    const egress = new SeoEgressGuard(false, true);
    const governor = await freshGovernor();
    const adapter = new DataForSeoAdapter(egress, governor, throwingHttp(), auth);

    await expect(adapter.serp(serpQuery)).resolves.toEqual({ kind: "abstain", reason: "source-error" });
    await expect(adapter.keywords(keywordQuery)).resolves.toEqual({ kind: "abstain", reason: "source-error" });
    await expect(adapter.backlinks(backlinkQuery)).resolves.toEqual({ kind: "abstain", reason: "source-error" });
    expect(governor.spentUsd()).toBe(0);
  });
});

// -- sc-9-1: unsupported capabilities are always disabled --------------------

describe("DataForSeoAdapter — searchAnalytics/urlInspection are always disabled (sc-9-1)", () => {
  it("capabilities() advertises only serp, keywords, backlinks", async () => {
    const egress = new SeoEgressGuard(false, true);
    const governor = await freshGovernor();
    const adapter = new DataForSeoAdapter(egress, governor, spyHttp({}).http, auth);
    expect(adapter.capabilities()).toEqual(["serp", "keywords", "backlinks"]);
  });

  it("searchAnalytics/urlInspection resolve disabled regardless of axis state, with zero network", async () => {
    for (const on of [true, false]) {
      const egress = new SeoEgressGuard(false, on);
      const governor = await freshGovernor();
      const { http, calls } = spyHttp({});
      const adapter = new DataForSeoAdapter(egress, governor, http, auth);

      await expect(
        adapter.searchAnalytics({ siteUrl: "https://example.com", startDate: "2026-06-01", endDate: "2026-06-30", dimensions: ["query"] }),
      ).resolves.toEqual({ kind: "disabled" });
      await expect(
        adapter.urlInspection({ siteUrl: "https://example.com", inspectionUrl: "https://example.com/page" }),
      ).resolves.toEqual({ kind: "disabled" });
      expect(calls).toHaveLength(0);
    }
  });
});

// -- sc-9-4 / confinement: the http import is confined to src/seo/adapters/ --

describe("DataForSeoAdapter — real fetch/http import confinement (sc-9-4)", () => {
  it("dataforseo-adapter.ts references no bare fetch(...) call and no node:http(s) import", async () => {
    const source = await readFile(join(HERE, "dataforseo-adapter.ts"), "utf-8");
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
