import { describe, it, expect } from "vitest";
import { FactStore } from "../state/facts.js";
import { HUB_SCOPE } from "./finding-source.js";
import { captureTask } from "./task-inbox.js";

const T = "2026-06-28T00:00:00.000Z";

describe("captureTask", () => {
  // sc-1-3: captures one open action finding with dueBy absent
  it("sc-1-3: captures one open action finding for 'renew passport'", async () => {
    const store = new FactStore(":memory:");
    await captureTask(store, "renew passport", { now: T });
    const rows = store.getActiveFacts(HUB_SCOPE, undefined, "finding");
    expect(rows).toHaveLength(1);
    const f = JSON.parse(rows[0]!.value) as Record<string, unknown>;
    expect(f["kind"]).toBe("action");
    expect(f["status"]).toBe("open");
    expect(f["title"]).toBe("renew passport");
    expect(f["dueBy"]).toBeUndefined();
    store.close();
  });

  // sc-1-4: no domain → domain='inbox', no domain tag
  it("sc-1-4: no domain → domain=inbox and no domain tag", async () => {
    const store = new FactStore(":memory:");
    const finding = await captureTask(store, "buy groceries", { now: T });
    expect(finding.domain).toBe("inbox");
    expect(finding.tags).toEqual([]);
    store.close();
  });

  // sc-1-4: --domain medical → carries that domain
  it("sc-1-4: domain=medical → carries domain field and tag", async () => {
    const store = new FactStore(":memory:");
    const finding = await captureTask(store, "schedule MRI", { domain: "medical", now: T });
    expect(finding.domain).toBe("medical");
    expect(finding.tags).toContain("domain:medical");
    store.close();
  });

  it("trims whitespace from text", async () => {
    const store = new FactStore(":memory:");
    const finding = await captureTask(store, "  renew passport  ", { now: T });
    expect(finding.title).toBe("renew passport");
    store.close();
  });

  it("neutral urgency=3 and severity=1 are set", async () => {
    const store = new FactStore(":memory:");
    const finding = await captureTask(store, "test task", { now: T });
    expect(finding.urgency).toBe(3);
    expect(finding.severity).toBe(1);
    store.close();
  });

  it("surfacedAt equals injected now", async () => {
    const store = new FactStore(":memory:");
    const finding = await captureTask(store, "test task", { now: T });
    expect(finding.surfacedAt).toBe(T);
    store.close();
  });

  it("two calls with different now produce different ids", async () => {
    const store = new FactStore(":memory:");
    const T2 = "2026-06-29T00:00:00.000Z";
    const f1 = await captureTask(store, "same text", { now: T });
    const f2 = await captureTask(store, "same text", { now: T2 });
    expect(f1.id).not.toBe(f2.id);
    store.close();
  });
});
