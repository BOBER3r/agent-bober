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
