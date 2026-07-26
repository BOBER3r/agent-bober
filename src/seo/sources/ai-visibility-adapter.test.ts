import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SeoEgressGuard } from "../egress.js";
import { SeoQuotaGovernor } from "../quota-governor.js";
import type { BoberConfig } from "../../config/schema.js";
import { AiVisibilityAdapter } from "./ai-visibility-adapter.js";
import type { AiVisibilityProvider } from "./ai-visibility-adapter.js";
import type { AiVisibilityRow } from "../data-source.js";

/** Temp dirs created by `freshGovernor()` across the whole file — swept in the top-level `afterEach`. */
const tempDirs: string[] = [];

async function freshGovernor(maxUsd: number | null = null): Promise<SeoQuotaGovernor> {
  const dir = await mkdtemp(join(tmpdir(), "ai-visibility-adapter-"));
  tempDirs.push(dir);
  return SeoQuotaGovernor.load(join(dir, "quota-ledger.json"), { seo: { budget: { maxUsd } } } as BoberConfig);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

type ProbeCall = { target: string; prompts: string[]; locale?: string };

/** Records every probe and returns canned rows. Never opens a real socket. */
function fakeProvider(
  rows: AiVisibilityRow[],
  estCostUsdPerPrompt = 0.01,
): { provider: AiVisibilityProvider; calls: ProbeCall[] } {
  const calls: ProbeCall[] = [];
  const provider: AiVisibilityProvider = {
    name: "fake",
    estCostUsdPerPrompt,
    async probe(target, prompts, locale) {
      calls.push({ target, prompts, locale });
      return rows;
    },
  };
  return { provider, calls };
}

/** A provider whose probe rejects before ever resolving — simulates a vendor-side failure. */
function throwingProvider(): AiVisibilityProvider {
  return {
    name: "throwing",
    estCostUsdPerPrompt: 0.01,
    probe(): Promise<AiVisibilityRow[]> {
      throw new Error("probe failed");
    },
  };
}

const query = { target: "https://target.example", prompts: ["best casino", "top exchange"], locale: "en-US" };
const rowFixture: AiVisibilityRow[] = [
  { prompt: "best casino", provider: "fake", mentioned: true, rank: 2, citationPresent: true, sourceUrls: ["https://target.example/a"] },
];

// -- sc-5-2: axis OFF -> abstain, ZERO sockets, ZERO booking ----------------

describe("AiVisibilityAdapter — egress axis OFF => abstain with zero sockets + zero booking (sc-5-2)", () => {
  it("axis off resolves abstain, provider.probe is NEVER called, and spentUsd is unchanged", async () => {
    const { provider, calls } = fakeProvider(rowFixture);
    const governor = await freshGovernor();
    // SeoEgressGuard(searchConsole, serpProvider, aiVisibility, siteCrawl) — ai-visibility is the 3rd positional.
    const adapter = new AiVisibilityAdapter(new SeoEgressGuard(false, false, false), governor, provider);

    const out = await adapter.aiVisibility(query);
    expect(out).toEqual({ kind: "abstain", reason: "egress-ai-visibility-disabled" });
    expect(calls).toHaveLength(0); // zero-socket proof: probe never ran
    expect(governor.spentUsd()).toBe(0); // nothing booked
  });

  it("axis off with other axes ON still abstains (axes are independent)", async () => {
    const { provider, calls } = fakeProvider(rowFixture);
    const governor = await freshGovernor();
    const adapter = new AiVisibilityAdapter(new SeoEgressGuard(true, true, false, true), governor, provider);

    const out = await adapter.aiVisibility(query);
    expect(out).toEqual({ kind: "abstain", reason: "egress-ai-visibility-disabled" });
    expect(calls).toHaveLength(0);
  });

  it("zero-socket belt-and-suspenders: resolves abstain even if global fetch is forced to throw", async () => {
    const original = globalThis.fetch;
    // @ts-expect-error force any accidental network attempt to blow up loudly
    globalThis.fetch = () => {
      throw new Error("network forbidden in AiVisibilityAdapter");
    };
    try {
      const { provider } = fakeProvider(rowFixture);
      const governor = await freshGovernor();
      const adapter = new AiVisibilityAdapter(new SeoEgressGuard(false, false, false), governor, provider);
      const out = await adapter.aiVisibility(query);
      expect(out).toEqual({ kind: "abstain", reason: "egress-ai-visibility-disabled" });
    } finally {
      globalThis.fetch = original;
    }
  });
});

// -- sc-5-1 / sc-5-2: axis ON + fake provider -> typed data + USD booking ---

describe("AiVisibilityAdapter — axis ON + fake provider => typed data + USD booking (sc-5-1, sc-5-2)", () => {
  it("returns typed rows + provenance{source:'ai-visibility', costUsd} and books cost on success", async () => {
    const { provider, calls } = fakeProvider(rowFixture, 0.01);
    const governor = await freshGovernor(1);
    const adapter = new AiVisibilityAdapter(new SeoEgressGuard(false, false, true), governor, provider);

    const out = await adapter.aiVisibility(query);
    expect(out.kind).toBe("data");
    if (out.kind !== "data") return;

    expect(out.rows).toEqual(rowFixture);
    expect(out.provenance.source).toBe("ai-visibility");
    expect(typeof out.provenance.retrievedAt).toBe("string");
    expect(out.provenance.costUsd).toBeCloseTo(0.02, 6); // 0.01 * 2 prompts

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ target: query.target, prompts: query.prompts, locale: query.locale });

    expect(governor.spentUsd()).toBeCloseTo(0.02, 6);
  });

  it("passes prompts/target/locale through to the provider unchanged", async () => {
    const { provider, calls } = fakeProvider([]);
    const governor = await freshGovernor();
    const adapter = new AiVisibilityAdapter(new SeoEgressGuard(false, false, true), governor, provider);

    await adapter.aiVisibility(query);
    expect(calls[0].target).toBe(query.target);
    expect(calls[0].prompts).toEqual(query.prompts);
    expect(calls[0].locale).toBe(query.locale);
  });
});

// -- sc-5-2: budget-exceeded admit opens ZERO sockets ------------------------

describe("AiVisibilityAdapter — budget-exceeded admit opens ZERO sockets (sc-5-2)", () => {
  it("a cap below the estimated cost refuses admission before probe() runs", async () => {
    const { provider, calls } = fakeProvider(rowFixture, 0.5); // 0.5 * 2 = $1.00 estimate
    const governor = await freshGovernor(0.5); // cap BELOW the $1.00 estimate
    const adapter = new AiVisibilityAdapter(new SeoEgressGuard(false, false, true), governor, provider);

    const out = await adapter.aiVisibility(query);
    expect(out).toEqual({ kind: "abstain", reason: "budget-exceeded" });
    expect(calls).toHaveLength(0); // admit refused before any probe
    expect(governor.spentUsd()).toBe(0);
  });
});

// -- sc-5-2 / sc-5-4: provider errors degrade to abstain, NEVER throw, NOTHING booked --

describe("AiVisibilityAdapter — provider error degrades to abstain, never throws, nothing booked (sc-5-2, sc-5-4)", () => {
  it("a throwing provider resolves abstain{source-error} (not throw) and books nothing", async () => {
    const governor = await freshGovernor();
    const adapter = new AiVisibilityAdapter(new SeoEgressGuard(false, false, true), governor, throwingProvider());

    await expect(adapter.aiVisibility(query)).resolves.toEqual({ kind: "abstain", reason: "source-error" });
    expect(governor.spentUsd()).toBe(0); // record() NOT called on a rejected probe
  });

  it("a provider whose probe() rejects (async throw) also degrades to abstain, books nothing", async () => {
    const governor = await freshGovernor();
    const rejectingProvider: AiVisibilityProvider = {
      name: "rejecting",
      estCostUsdPerPrompt: 0.01,
      async probe() {
        throw new Error("upstream 5xx");
      },
    };
    const adapter = new AiVisibilityAdapter(new SeoEgressGuard(false, false, true), governor, rejectingProvider);

    await expect(adapter.aiVisibility(query)).resolves.toEqual({ kind: "abstain", reason: "source-error" });
    expect(governor.spentUsd()).toBe(0);
  });
});

// -- sc-5-1: only ai-visibility is served; every other capability is disabled --

describe("AiVisibilityAdapter — only ai-visibility is served, all other capabilities disabled (sc-5-1)", () => {
  it("capabilities() advertises only ai-visibility", async () => {
    const { provider } = fakeProvider(rowFixture);
    const governor = await freshGovernor();
    const adapter = new AiVisibilityAdapter(new SeoEgressGuard(false, false, true), governor, provider);
    expect(adapter.capabilities()).toEqual(["ai-visibility"]);
  });

  it("every other capability method resolves disabled regardless of axis state, with zero probes", async () => {
    for (const on of [true, false]) {
      const { provider, calls } = fakeProvider(rowFixture);
      const governor = await freshGovernor();
      const adapter = new AiVisibilityAdapter(new SeoEgressGuard(false, false, on), governor, provider);

      await expect(
        adapter.searchAnalytics({ siteUrl: "https://example.com", startDate: "2026-06-01", endDate: "2026-06-30", dimensions: ["query"] }),
      ).resolves.toEqual({ kind: "disabled" });
      await expect(
        adapter.urlInspection({ siteUrl: "https://example.com", inspectionUrl: "https://example.com/page" }),
      ).resolves.toEqual({ kind: "disabled" });
      await expect(adapter.serp({ keyword: "best casino", location: "United States" })).resolves.toEqual({ kind: "disabled" });
      await expect(adapter.keywords({ keywords: ["x"], location: "us" })).resolves.toEqual({ kind: "disabled" });
      await expect(adapter.backlinks({ target: "https://example.com" })).resolves.toEqual({ kind: "disabled" });
      await expect(adapter.linkGraph({ rootUrl: "https://example.com" })).resolves.toEqual({ kind: "disabled" });
      expect(calls).toHaveLength(0);
    }
  });
});
