import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { TopologySpecSchema } from "../../contracts/topology.js";
import type { TopologySpec } from "../../contracts/topology.js";
import { canonicalize, checksumMatches, checksumTopology } from "./canonical.js";

const VALID_FIXTURE_URL = new URL("./__fixtures__/valid.json", import.meta.url);

async function loadValid(): Promise<TopologySpec> {
  return TopologySpecSchema.parse(JSON.parse(await readFile(VALID_FIXTURE_URL, "utf8")));
}

/** Rebuild an object graph with every object's keys in reverse order and every array reversed. */
function scramble(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scramble).reverse();
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).reverse()) out[key] = scramble(src[key]);
    return out;
  }
  return value;
}

describe("canonicalize", () => {
  let spec: TopologySpec;

  beforeAll(async () => {
    spec = await loadValid();
  });

  it("elides the checksum field", () => {
    const text = canonicalize(spec);
    expect(text).not.toContain('"checksum"');
    expect(text).not.toContain(spec.checksum);
  });

  it("emits object keys in sorted order at every level", () => {
    const text = canonicalize(spec);
    const round = JSON.parse(text) as Record<string, unknown>;
    const topKeys = Object.keys(round);
    expect(topKeys).toEqual([...topKeys].sort());
    expect(topKeys[0]).toBe("channels");
    expect(topKeys).not.toContain("checksum");
    expect(text.startsWith('{"channels":')).toBe(true);

    const nodes = round.nodes as Array<Record<string, unknown>>;
    for (const node of nodes) {
      expect(Object.keys(node)).toEqual([...Object.keys(node)].sort());
    }
  });

  it("orders arrays of objects by their intrinsic key", () => {
    const round = JSON.parse(canonicalize(spec)) as Record<string, unknown>;
    const nodeIds = (round.nodes as Array<{ id: string }>).map((n) => n.id);
    expect(nodeIds).toEqual([...nodeIds].sort());
    const edgeIds = (round.edges as Array<{ id: string }>).map((e) => e.id);
    expect(edgeIds).toEqual([...edgeIds].sort());
    const channelIds = (round.channels as Array<{ id: string }>).map((c) => c.id);
    expect(channelIds).toEqual(["branchStatus", "counters", "messages", "spec"]);

    const router = (round.nodes as Array<Record<string, unknown>>).find((n) => n.id === "plan_route");
    const labels = (router?.targets as Array<{ label: string }>).map((t) => t.label);
    expect(labels).toEqual(["ok", "retry"]);
  });

  it("is stable across repeated calls", () => {
    expect(canonicalize(spec)).toBe(canonicalize(spec));
  });

  it("produces the identical string for two structurally identical specs with different key and array order", () => {
    const scrambled = scramble(spec) as TopologySpec;
    // Sanity: the scrambled object really does differ from the original serialization.
    expect(JSON.stringify(scrambled)).not.toBe(JSON.stringify(spec));
    expect(canonicalize(scrambled)).toBe(canonicalize(spec));
  });

  it("changes when a structural field changes", () => {
    const mutated = JSON.parse(JSON.stringify(spec)) as TopologySpec;
    mutated.nodes[0].title = "Different title";
    expect(canonicalize(mutated)).not.toBe(canonicalize(spec));
  });
});

describe("checksumTopology", () => {
  let spec: TopologySpec;

  beforeAll(async () => {
    spec = await loadValid();
  });

  it("returns a sha256:<64 hex> value", () => {
    const sum = checksumTopology(spec);
    expect(sum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sum.slice("sha256:".length)).toHaveLength(64);
  });

  it("matches the checksum committed in the artifact", () => {
    expect(checksumTopology(spec)).toBe(spec.checksum);
    expect(checksumMatches(spec)).toBe(true);
  });

  it("is identical for two structurally identical specs with different key order", () => {
    const scrambled = scramble(spec) as TopologySpec;
    expect(checksumTopology(scrambled)).toBe(checksumTopology(spec));
  });

  it("ignores the stored checksum when computing the new one", () => {
    const tampered = JSON.parse(JSON.stringify(spec)) as TopologySpec;
    tampered.checksum = `sha256:${"b".repeat(64)}`;
    expect(checksumTopology(tampered)).toBe(checksumTopology(spec));
    expect(checksumMatches(tampered)).toBe(false);
  });

  it("changes when any structural field changes", () => {
    const before = checksumTopology(spec);
    const renamed = JSON.parse(JSON.stringify(spec)) as TopologySpec;
    renamed.graphVersion = "1.0.1";
    expect(checksumTopology(renamed)).not.toBe(before);

    const rewired = JSON.parse(JSON.stringify(spec)) as TopologySpec;
    rewired.edges[0].to = "plan_route";
    expect(checksumTopology(rewired)).not.toBe(before);
  });

  it("is insensitive to the authored order of set-valued string arrays", () => {
    const reordered = JSON.parse(JSON.stringify(spec)) as TopologySpec;
    const draft = reordered.nodes.find((n) => n.id === "plan_draft");
    expect(draft?.writes).toEqual(["messages", "spec"]);
    if (draft) draft.writes = ["spec", "messages"];
    expect(checksumTopology(reordered)).toBe(checksumTopology(spec));
  });
});
