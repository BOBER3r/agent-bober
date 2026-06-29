import { describe, it, expect } from "vitest";
import { FactStore } from "../state/facts.js";
import { writeFinding } from "../hub/finding-store.js";
import { FactStoreFindingStore, InMemoryFindingStore } from "./finding-port.js";
import type { Finding } from "../hub/finding.js";

const T = "2026-06-28T00:00:00.000Z";

const SAMPLE_FINDING: Finding = {
  id: "abc123def456abc1",
  domain: "coding",
  title: "fix the CI build",
  kind: "action",
  urgency: 3,
  severity: 2,
  evidence: ["build fails on node 20"],
  surfacedAt: T,
  tags: [],
  status: "open",
};

// ── FactStoreFindingStore ─────────────────────────────────────────────

describe("FactStoreFindingStore", () => {
  it("returns null for an unknown id", async () => {
    const store = new FactStore(":memory:");
    const port = new FactStoreFindingStore(store);
    const result = await port.readFinding("nonexistent-id");
    expect(result).toBeNull();
    store.close();
  });

  it("reads back a persisted finding by id", async () => {
    const store = new FactStore(":memory:");
    await writeFinding(store, SAMPLE_FINDING, { now: T });

    const port = new FactStoreFindingStore(store);
    const result = await port.readFinding(SAMPLE_FINDING.id);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(SAMPLE_FINDING.id);
    expect(result!.title).toBe("fix the CI build");
    expect(result!.domain).toBe("coding");
    store.close();
  });

  it("returns null when id does not match any stored finding", async () => {
    const store = new FactStore(":memory:");
    await writeFinding(store, SAMPLE_FINDING, { now: T });

    const port = new FactStoreFindingStore(store);
    const result = await port.readFinding("wrong-id");
    expect(result).toBeNull();
    store.close();
  });
});

// ── InMemoryFindingStore ──────────────────────────────────────────────

describe("InMemoryFindingStore", () => {
  it("returns seeded finding by id", async () => {
    const fakeStore = new InMemoryFindingStore([SAMPLE_FINDING]);
    const result = await fakeStore.readFinding(SAMPLE_FINDING.id);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(SAMPLE_FINDING.id);
  });

  it("returns null for an unknown id", async () => {
    const fakeStore = new InMemoryFindingStore([SAMPLE_FINDING]);
    const result = await fakeStore.readFinding("does-not-exist");
    expect(result).toBeNull();
  });

  it("starts with empty writes array — no write path this sprint", () => {
    const fakeStore = new InMemoryFindingStore([SAMPLE_FINDING]);
    expect(fakeStore.writes).toHaveLength(0);
  });

  it("writes array stays empty after reads (no mutation)", async () => {
    const fakeStore = new InMemoryFindingStore([SAMPLE_FINDING]);
    await fakeStore.readFinding(SAMPLE_FINDING.id);
    await fakeStore.readFinding("nonexistent");
    expect(fakeStore.writes).toHaveLength(0);
  });

  it("can be seeded with multiple findings", async () => {
    const findingB: Finding = {
      ...SAMPLE_FINDING,
      id: "bbbbbbbbbbbbbbbb",
      title: "deploy service",
    };
    const fakeStore = new InMemoryFindingStore([SAMPLE_FINDING, findingB]);
    expect(await fakeStore.readFinding(SAMPLE_FINDING.id)).not.toBeNull();
    expect(await fakeStore.readFinding(findingB.id)).not.toBeNull();
    expect(await fakeStore.readFinding("unknown")).toBeNull();
  });
});
