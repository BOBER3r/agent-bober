import { describe, it, expect } from "vitest";
import { EgressGuard } from "./egress.js";
import type { BoberConfig } from "../config/schema.js";

// ── sc-6-5: EgressGuard two independent axes default false ─────────

describe("EgressGuard — two independent axes default false (sc-6-5)", () => {
  it("both axes default false; isAllowed returns false", () => {
    const g = new EgressGuard(false, false);
    expect(g.isAllowed("cloud-inference")).toBe(false);
    expect(g.isAllowed("literature-retrieval")).toBe(false);
  });

  it("assertAllowed throws for cloud-inference when off", () => {
    const g = new EgressGuard(false, false);
    expect(() => g.assertAllowed("cloud-inference")).toThrow("Egress axis 'cloud-inference' not enabled");
  });

  it("assertAllowed throws for literature-retrieval when off", () => {
    const g = new EgressGuard(false, false);
    expect(() => g.assertAllowed("literature-retrieval")).toThrow("Egress axis 'literature-retrieval' not enabled");
  });

  it("axes are independent: enabling literature does NOT enable cloud", () => {
    const g = new EgressGuard(false, true);
    expect(g.isAllowed("literature-retrieval")).toBe(true);
    expect(g.isAllowed("cloud-inference")).toBe(false);
    expect(() => g.assertAllowed("literature-retrieval")).not.toThrow();
    expect(() => g.assertAllowed("cloud-inference")).toThrow();
  });

  it("axes are independent: enabling cloud does NOT enable literature", () => {
    const g = new EgressGuard(true, false);
    expect(g.isAllowed("cloud-inference")).toBe(true);
    expect(g.isAllowed("literature-retrieval")).toBe(false);
    expect(() => g.assertAllowed("cloud-inference")).not.toThrow();
    expect(() => g.assertAllowed("literature-retrieval")).toThrow();
  });

  it("both axes on: both isAllowed true, assertAllowed does not throw", () => {
    const g = new EgressGuard(true, true);
    expect(g.isAllowed("cloud-inference")).toBe(true);
    expect(g.isAllowed("literature-retrieval")).toBe(true);
    expect(() => g.assertAllowed("cloud-inference")).not.toThrow();
    expect(() => g.assertAllowed("literature-retrieval")).not.toThrow();
  });

  it("fromConfig defaults both false when medical section absent", () => {
    const g = EgressGuard.fromConfig({} as BoberConfig);
    expect(g.isAllowed("cloud-inference")).toBe(false);
    expect(g.isAllowed("literature-retrieval")).toBe(false);
  });

  it("fromConfig defaults both false when medical.egress absent", () => {
    const g = EgressGuard.fromConfig({ medical: {} } as BoberConfig);
    expect(g.isAllowed("cloud-inference")).toBe(false);
    expect(g.isAllowed("literature-retrieval")).toBe(false);
  });

  it("fromConfig reads literatureRetrieval=true from config", () => {
    const g = EgressGuard.fromConfig({
      medical: { egress: { cloudInference: false, literatureRetrieval: true } },
    } as BoberConfig);
    expect(g.isAllowed("literature-retrieval")).toBe(true);
    expect(g.isAllowed("cloud-inference")).toBe(false);
  });
});
