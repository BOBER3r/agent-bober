import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BoberConfig } from "../config/schema.js";
import { SeoEgressGuard } from "./egress.js";
import { SeoQuotaGovernor } from "./quota-governor.js";
import { DataForSeoAdapter } from "./sources/dataforseo-adapter.js";
import { DataForSeoSerpProvider } from "./sources/dataforseo-serp-provider.js";
import { DamcrawlerSerpProvider } from "./sources/damcrawler-serp-provider.js";
import { resolveSerpProvider } from "./serp-provider.js";

const tempDirs: string[] = [];

/** `resolveSerpProvider` never calls the governor directly — only threads it into `DataForSeoAdapter`. */
async function fakeGovernor(): Promise<SeoQuotaGovernor> {
  const dir = await mkdtemp(join(tmpdir(), "serp-provider-factory-"));
  tempDirs.push(dir);
  return SeoQuotaGovernor.load(join(dir, "quota-ledger.json"), {} as BoberConfig);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

// -- sc-8-3: config.seo.serp.provider selects the impl; default preserves today's behavior byte-identically --

describe("resolveSerpProvider — config.seo.serp.provider selects the impl (default 'dataforseo', sc-8-3)", () => {
  it("config omitting `seo` entirely defaults to DataForSeoSerpProvider (byte-identical default)", async () => {
    const config = {} as BoberConfig;
    const egress = new SeoEgressGuard(false, true);
    const adapter = new DataForSeoAdapter(egress, await fakeGovernor());

    const provider = resolveSerpProvider(config, adapter, egress);
    expect(provider).toBeInstanceOf(DataForSeoSerpProvider);
    expect(provider.name).toBe("dataforseo");
  });

  it("config omitting `serp` (but present `seo`) also defaults to DataForSeoSerpProvider", async () => {
    const config = { seo: {} } as BoberConfig;
    const egress = new SeoEgressGuard(false, true);
    const adapter = new DataForSeoAdapter(egress, await fakeGovernor());

    const provider = resolveSerpProvider(config, adapter, egress);
    expect(provider).toBeInstanceOf(DataForSeoSerpProvider);
  });

  it("explicit provider:'dataforseo' resolves DataForSeoSerpProvider", async () => {
    const config = { seo: { serp: { provider: "dataforseo" as const } } } as BoberConfig;
    const egress = new SeoEgressGuard(false, true);
    const adapter = new DataForSeoAdapter(egress, await fakeGovernor());

    const provider = resolveSerpProvider(config, adapter, egress);
    expect(provider).toBeInstanceOf(DataForSeoSerpProvider);
  });

  it("explicit provider:'damcrawler' resolves DamcrawlerSerpProvider (gated by site-crawl, not serp-provider — ADR-10)", async () => {
    const config = { seo: { serp: { provider: "damcrawler" as const } } } as BoberConfig;
    const egress = new SeoEgressGuard(false, true, false, true); // site-crawl ON
    const adapter = new DataForSeoAdapter(egress, await fakeGovernor());

    const provider = resolveSerpProvider(config, adapter, egress);
    expect(provider).toBeInstanceOf(DamcrawlerSerpProvider);
    expect(provider.name).toBe("damcrawler");
    expect(provider.estCostUsdPerResult).toBe(0);
  });
});
