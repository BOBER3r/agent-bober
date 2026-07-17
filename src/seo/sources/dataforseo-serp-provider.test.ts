import { describe, it, expect, afterEach } from "vitest";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SeoEgressGuard } from "../egress.js";
import { SeoQuotaGovernor } from "../quota-governor.js";
import type { BoberConfig } from "../../config/schema.js";
import type { HttpClient, HttpRequestInit, HttpResponse } from "../adapters/http.js";
import { DataForSeoAdapter } from "./dataforseo-adapter.js";
import { DataForSeoSerpProvider } from "./dataforseo-serp-provider.js";

const SERP_FIXTURE = new URL("../__fixtures__/dataforseo/serp.json", import.meta.url);
const auth = async () => "dGVzdDp0ZXN0";
const serpQuery = { keyword: "best casino", location: "United States" };

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

const tempDirs: string[] = [];

async function freshGovernor(maxUsd: number | null = null): Promise<SeoQuotaGovernor> {
  const dir = await mkdtemp(join(tmpdir(), "dataforseo-serp-provider-"));
  tempDirs.push(dir);
  return SeoQuotaGovernor.load(join(dir, "quota-ledger.json"), { seo: { budget: { maxUsd } } } as BoberConfig);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// -- sc-8-1: byte-identical to the wrapped DataForSeoAdapter.serp path --

describe("DataForSeoSerpProvider — output byte-identical to DataForSeoAdapter.serp under axis serp-provider (sc-8-1)", () => {
  it("wrapper output matches calling adapter.serp directly for the same fixture", async () => {
    const fixture = JSON.parse(await readFile(SERP_FIXTURE, "utf-8"));

    const directEgress = new SeoEgressGuard(false, true); // serp-provider ON
    const directGovernor = await freshGovernor(1);
    const { http: directHttp } = spyHttp(fixture);
    const directAdapter = new DataForSeoAdapter(directEgress, directGovernor, directHttp, auth);
    const direct = await directAdapter.serp({ keyword: serpQuery.keyword, location: serpQuery.location });

    const wrappedEgress = new SeoEgressGuard(false, true);
    const wrappedGovernor = await freshGovernor(1);
    const { http: wrappedHttp } = spyHttp(fixture);
    const wrappedAdapter = new DataForSeoAdapter(wrappedEgress, wrappedGovernor, wrappedHttp, auth);
    const provider = new DataForSeoSerpProvider(wrappedAdapter);
    const wrapped = await provider.serp(serpQuery.keyword, serpQuery.location);

    expect(direct.kind).toBe("data");
    expect(wrapped.kind).toBe("data");
    if (direct.kind !== "data" || wrapped.kind !== "data") return;

    expect(wrapped.rows).toEqual(direct.rows);
    expect(wrapped.provenance.source).toBe(direct.provenance.source);
    expect(wrapped.provenance.costUsd).toBeCloseTo(direct.provenance.costUsd ?? 0, 6);
    expect(typeof wrapped.provenance.retrievedAt).toBe("string");

    // Both governors advanced by exactly the same USD — proves the wrapper
    // does not double-book (or under-book) the wrapped adapter's charge.
    expect(wrappedGovernor.spentUsd()).toBeCloseTo(directGovernor.spentUsd(), 6);
  });

  it("provider metadata: name='dataforseo', estCostUsdPerResult=0.0006", async () => {
    const egress = new SeoEgressGuard(false, true);
    const governor = await freshGovernor();
    const { http } = spyHttp({ tasks: [] });
    const provider = new DataForSeoSerpProvider(new DataForSeoAdapter(egress, governor, http, auth));
    expect(provider.name).toBe("dataforseo");
    expect(provider.estCostUsdPerResult).toBeCloseTo(0.0006, 6);
  });
});

// -- sc-8-4: metered path books actual USD via governor.record; axis-off never re-implements the gate --

describe("DataForSeoSerpProvider — axis OFF => abstain via the wrapped adapter (no gate bypass); axis ON books USD once (sc-8-4)", () => {
  it("axis off resolves the SAME abstain as the direct adapter — the wrapper does not bypass the egress gate", async () => {
    const egress = new SeoEgressGuard(false, false); // serp-provider off
    const governor = await freshGovernor();
    const { http, calls } = spyHttp({ tasks: [] });
    const provider = new DataForSeoSerpProvider(new DataForSeoAdapter(egress, governor, http, auth));

    const out = await provider.serp(serpQuery.keyword, serpQuery.location);
    expect(out).toEqual({ kind: "abstain", reason: "egress-serp-provider-disabled" });
    expect(calls).toHaveLength(0);
    expect(governor.spentUsd()).toBe(0);
  });

  it("axis on + successful fixture books exactly $0.0006 ONCE via governor.record (no double-booking)", async () => {
    const fixture = JSON.parse(await readFile(SERP_FIXTURE, "utf-8"));
    const egress = new SeoEgressGuard(false, true);
    const governor = await freshGovernor(1);
    const { http } = spyHttp(fixture);
    const provider = new DataForSeoSerpProvider(new DataForSeoAdapter(egress, governor, http, auth));

    const out = await provider.serp(serpQuery.keyword, serpQuery.location);
    expect(out.kind).toBe("data");
    if (out.kind !== "data") return;
    expect(out.provenance.costUsd).toBeCloseTo(0.0006, 6);
    expect(governor.spentUsd()).toBeCloseTo(0.0006, 6); // NOT 0.0012 — proves no re-booking in the wrapper
  });

  it("wrapper never throws even when the underlying HTTP call fails", async () => {
    const egress = new SeoEgressGuard(false, true);
    const governor = await freshGovernor(1);
    const http: HttpClient = {
      request(): Promise<HttpResponse> {
        throw new Error("network unreachable");
      },
    };
    const provider = new DataForSeoSerpProvider(new DataForSeoAdapter(egress, governor, http, auth));
    await expect(provider.serp(serpQuery.keyword, serpQuery.location)).resolves.toEqual({
      kind: "abstain",
      reason: "source-error",
    });
    expect(governor.spentUsd()).toBe(0); // failed round-trip books nothing
  });
});
