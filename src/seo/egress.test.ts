import { describe, it, expect } from "vitest";
import { SeoEgressGuard } from "./egress.js";
import type { BoberConfig } from "../config/schema.js";

// ── sc-1-4 / stopConditions: SeoEgressGuard two axes default false ──────

describe("SeoEgressGuard — two axes default false (sc-1-4)", () => {
  it("both axes default false; isAllowed returns false", () => {
    const g = new SeoEgressGuard(false, false);
    expect(g.isAllowed("search-console")).toBe(false);
    expect(g.isAllowed("serp-provider")).toBe(false);
  });

  it("assertAllowed throws for search-console when off", () => {
    const g = new SeoEgressGuard(false, false);
    expect(() => g.assertAllowed("search-console")).toThrow(
      "Egress axis 'search-console' not enabled",
    );
  });

  it("assertAllowed throws for serp-provider when off", () => {
    const g = new SeoEgressGuard(false, false);
    expect(() => g.assertAllowed("serp-provider")).toThrow(
      "Egress axis 'serp-provider' not enabled",
    );
  });

  it("axes are independent: enabling search-console does NOT enable serp-provider", () => {
    const g = new SeoEgressGuard(true, false);
    expect(g.isAllowed("search-console")).toBe(true);
    expect(g.isAllowed("serp-provider")).toBe(false);
    expect(() => g.assertAllowed("search-console")).not.toThrow();
    expect(() => g.assertAllowed("serp-provider")).toThrow();
  });

  it("axes are independent: enabling serp-provider does NOT enable search-console", () => {
    const g = new SeoEgressGuard(false, true);
    expect(g.isAllowed("serp-provider")).toBe(true);
    expect(g.isAllowed("search-console")).toBe(false);
    expect(() => g.assertAllowed("serp-provider")).not.toThrow();
    expect(() => g.assertAllowed("search-console")).toThrow();
  });

  it("both axes on: both isAllowed true, assertAllowed does not throw", () => {
    const g = new SeoEgressGuard(true, true);
    expect(g.isAllowed("search-console")).toBe(true);
    expect(g.isAllowed("serp-provider")).toBe(true);
    expect(() => g.assertAllowed("search-console")).not.toThrow();
    expect(() => g.assertAllowed("serp-provider")).not.toThrow();
  });

  it("fromConfig defaults both false when seo section absent", () => {
    const g = SeoEgressGuard.fromConfig({} as BoberConfig);
    expect(g.isAllowed("search-console")).toBe(false);
    expect(g.isAllowed("serp-provider")).toBe(false);
  });

  it("fromConfig defaults both false when seo.egress absent", () => {
    const g = SeoEgressGuard.fromConfig({ seo: {} } as BoberConfig);
    expect(g.isAllowed("search-console")).toBe(false);
    expect(g.isAllowed("serp-provider")).toBe(false);
  });

  it("fromConfig reads an opted-in axis true; axes independent", () => {
    const g = SeoEgressGuard.fromConfig({
      seo: { egress: { "search-console": true, "serp-provider": false } },
    } as BoberConfig);
    expect(g.isAllowed("search-console")).toBe(true);
    expect(() => g.assertAllowed("search-console")).not.toThrow();
    expect(g.isAllowed("serp-provider")).toBe(false);
    expect(() => g.assertAllowed("serp-provider")).toThrow();
  });

  it("fromConfig reads serp-provider opted in independently of search-console", () => {
    const g = SeoEgressGuard.fromConfig({
      seo: { egress: { "search-console": false, "serp-provider": true } },
    } as BoberConfig);
    expect(g.isAllowed("serp-provider")).toBe(true);
    expect(g.isAllowed("search-console")).toBe(false);
  });
});

// ── sc-1-1 / sc-1-2: the two new axes (ai-visibility, site-crawl) ──────────

describe("SeoEgressGuard — ai-visibility and site-crawl axes default false (sc-1-1/sc-1-2)", () => {
  it("both new axes default false when omitted from the 2-arg ctor form", () => {
    const g = new SeoEgressGuard(false, false);
    expect(g.isAllowed("ai-visibility")).toBe(false);
    expect(g.isAllowed("site-crawl")).toBe(false);
  });

  it("assertAllowed throws for ai-visibility when off", () => {
    const g = new SeoEgressGuard(false, false);
    expect(() => g.assertAllowed("ai-visibility")).toThrow(
      "Egress axis 'ai-visibility' not enabled",
    );
  });

  it("assertAllowed throws for site-crawl when off", () => {
    const g = new SeoEgressGuard(false, false);
    expect(() => g.assertAllowed("site-crawl")).toThrow("Egress axis 'site-crawl' not enabled");
  });

  it("4-arg ctor: ai-visibility on does not enable any other axis", () => {
    const g = new SeoEgressGuard(false, false, true, false);
    expect(g.isAllowed("ai-visibility")).toBe(true);
    expect(g.isAllowed("site-crawl")).toBe(false);
    expect(g.isAllowed("search-console")).toBe(false);
    expect(g.isAllowed("serp-provider")).toBe(false);
    expect(() => g.assertAllowed("ai-visibility")).not.toThrow();
  });

  it("4-arg ctor: site-crawl on does not enable any other axis", () => {
    const g = new SeoEgressGuard(false, false, false, true);
    expect(g.isAllowed("site-crawl")).toBe(true);
    expect(g.isAllowed("ai-visibility")).toBe(false);
    expect(g.isAllowed("search-console")).toBe(false);
    expect(g.isAllowed("serp-provider")).toBe(false);
    expect(() => g.assertAllowed("site-crawl")).not.toThrow();
  });

  it("fromConfig defaults both new axes false when seo section absent", () => {
    const g = SeoEgressGuard.fromConfig({} as BoberConfig);
    expect(g.isAllowed("ai-visibility")).toBe(false);
    expect(g.isAllowed("site-crawl")).toBe(false);
  });

  it("fromConfig defaults both new axes false when seo.egress absent", () => {
    const g = SeoEgressGuard.fromConfig({ seo: {} } as BoberConfig);
    expect(g.isAllowed("ai-visibility")).toBe(false);
    expect(g.isAllowed("site-crawl")).toBe(false);
  });

  it("fromConfig reads ai-visibility opted in independently of the other three axes", () => {
    const g = SeoEgressGuard.fromConfig({
      seo: { egress: { "ai-visibility": true } },
    } as BoberConfig);
    expect(g.isAllowed("ai-visibility")).toBe(true);
    expect(g.isAllowed("site-crawl")).toBe(false);
    expect(g.isAllowed("search-console")).toBe(false);
    expect(g.isAllowed("serp-provider")).toBe(false);
  });

  it("fromConfig reads site-crawl opted in independently of the other three axes", () => {
    const g = SeoEgressGuard.fromConfig({
      seo: { egress: { "site-crawl": true } },
    } as BoberConfig);
    expect(g.isAllowed("site-crawl")).toBe(true);
    expect(g.isAllowed("ai-visibility")).toBe(false);
    expect(g.isAllowed("search-console")).toBe(false);
    expect(g.isAllowed("serp-provider")).toBe(false);
  });
});
