import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import {
  CHECKSUM_PATTERN,
  ChannelDeclSchema,
  EdgeSchema,
  KNOWN_REDUCERS,
  MAX_SUBGRAPH_DEPTH,
  NodeSchema,
  PortSchema,
  REDUCER_REFS,
  RouteTargetSchema,
  SubgraphDeclSchema,
  TERMINAL_ENDPOINT,
  TopologySpecSchema,
  isKnownReducer,
  isLlmNode,
  isRouterNode,
  isTerminalEndpoint,
  isToolNode,
  reducerProperties,
} from "./topology.js";
import type { TopologySpec } from "./topology.js";

const VALID_FIXTURE_URL = new URL("../pge/topology/__fixtures__/valid.json", import.meta.url);

async function loadValidRaw(): Promise<Record<string, unknown>> {
  const text = await readFile(VALID_FIXTURE_URL, "utf8");
  return JSON.parse(text) as Record<string, unknown>;
}

describe("TopologySpecSchema", () => {
  let raw: Record<string, unknown>;
  let spec: TopologySpec;

  beforeAll(async () => {
    raw = await loadValidRaw();
    spec = TopologySpecSchema.parse(raw);
  });

  it("parses a well-formed artifact carrying every declared top-level field", () => {
    expect(spec.formatVersion).toBe(1);
    expect(spec.graphId).toBe("fixture");
    expect(spec.graphVersion).toBe("1.0.0");
    expect(spec.description.length).toBeGreaterThan(0);
    expect(spec.provenance).toBe("authored");
    expect(spec.entry).toBe("gate_in");
    expect(spec.defaults.supervisorNodeId).toBe("supervisor");
    expect(spec.defaults.durability).toBe("superstep");
    expect(spec.defaults.concurrency).toBe(1);
    expect(spec.channels.map((c) => c.id)).toEqual([
      "messages",
      "counters",
      "spec",
      "branchStatus",
    ]);
    expect(spec.nodes).toHaveLength(12);
    expect(spec.edges).toHaveLength(14);
    expect(spec.checksum).toMatch(CHECKSUM_PATTERN);
    expect(spec.subgraphs).toHaveLength(1);
    expect(spec.subgraphs[0]).toMatchObject({
      id: "sprint",
      depth: 1,
      entryGate: "gate_sprint_in",
      exitGate: "gate_sprint_out",
      persistence: "inherit",
    });
  });

  // sc-1-1: every top-level field has a malformed variant that fails with a Zod issue
  // pinned to that field's path.
  const malformed: Array<{
    field: string;
    mutate: (r: Record<string, unknown>) => void;
    issuePath: string;
  }> = [
    { field: "formatVersion", mutate: (r) => void (r.formatVersion = 2), issuePath: "formatVersion" },
    { field: "graphId", mutate: (r) => void (r.graphId = ""), issuePath: "graphId" },
    { field: "graphVersion", mutate: (r) => void (r.graphVersion = "1.0"), issuePath: "graphVersion" },
    { field: "description", mutate: (r) => void (r.description = ""), issuePath: "description" },
    { field: "provenance", mutate: (r) => void (r.provenance = "hand-written"), issuePath: "provenance" },
    { field: "entry", mutate: (r) => void (r.entry = ""), issuePath: "entry" },
    { field: "defaults", mutate: (r) => void (r.defaults = {}), issuePath: "defaults.supervisorNodeId" },
    { field: "channels", mutate: (r) => void (r.channels = "not-an-array"), issuePath: "channels" },
    { field: "nodes", mutate: (r) => void (r.nodes = []), issuePath: "nodes" },
    { field: "edges", mutate: (r) => void (r.edges = [{}]), issuePath: "edges.0.id" },
    { field: "checksum", mutate: (r) => void (r.checksum = "sha256:zz"), issuePath: "checksum" },
    {
      field: "subgraphs",
      mutate: (r) => {
        r.subgraphs = [
          {
            id: "sprint",
            graphId: "fixture.sprint",
            depth: 1,
            entryGate: "gate_sprint_in",
            exitGate: "gate_sprint_out",
            persistence: "own",
          },
        ];
      },
      issuePath: "subgraphs.0.persistence",
    },
  ];

  it.each(malformed)("rejects a malformed $field with an issue at $issuePath", ({ mutate, issuePath }) => {
    const broken = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
    mutate(broken);
    const result = TopologySpecSchema.safeParse(broken);
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((issue) => issue.path.join("."));
    expect(paths).toContain(issuePath);
  });

  it("applies the documented defaults when optional fields are omitted", () => {
    const bare = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
    delete bare.provenance;
    const parsed = TopologySpecSchema.parse(bare);
    expect(parsed.provenance).toBe("authored");

    expect(PortSchema.parse({ key: "out", schemaRef: "PlanSpec" }).required).toBe(true);
    expect(EdgeSchema.parse({ id: "x", from: "a", to: "b" }).kind).toBe("normal");
    expect(
      ChannelDeclSchema.parse({
        id: "c",
        reducerRef: "setUnion",
        schemaRef: "S",
        scope: "public",
      }).maxInlineBytes,
    ).toBe(4096);
  });
});

describe("NodeSchema discriminated union", () => {
  let spec: TopologySpec;

  beforeAll(async () => {
    spec = TopologySpecSchema.parse(await loadValidRaw());
  });

  // sc-1-2: table-driven walk over every node of the fixture graph.
  it("enumerates every node and enforces the per-kind invariants", () => {
    expect(spec.nodes.length).toBeGreaterThan(0);
    const seenKinds = new Set<string>();
    let llmCount = 0;
    let toolCount = 0;
    let routerCount = 0;

    for (const node of spec.nodes) {
      seenKinds.add(node.kind);
      if (isLlmNode(node)) {
        llmCount += 1;
        expect(typeof node.promptRef, `llm node ${node.id} must carry a promptRef`).toBe("string");
        expect((node.promptRef as string).length).toBeGreaterThan(0);
        expect(node.modelTier === "light" || node.modelTier === "frontier").toBe(true);
      }
      if (isToolNode(node)) {
        toolCount += 1;
        expect(node.promptRef, `tool node ${node.id} must not carry a promptRef`).toBeUndefined();
        expect(typeof node.toolRef).toBe("string");
      }
      if (isRouterNode(node)) {
        routerCount += 1;
        expect(node.targets.length, `router ${node.id} must declare targets`).toBeGreaterThanOrEqual(1);
      }
    }

    expect(llmCount).toBe(2);
    expect(toolCount).toBe(3);
    expect(routerCount).toBe(2);
    expect([...seenKinds].sort()).toEqual(["gate", "llm", "router", "subgraph", "tool"]);
  });

  it("discriminates on kind and rejects an unknown kind", () => {
    const result = NodeSchema.safeParse({ id: "x", title: "X", kind: "webhook" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual(["kind"]);
  });

  it("requires kind-specific fields", () => {
    const base = { id: "n", title: "N" };
    expect(NodeSchema.safeParse({ ...base, kind: "llm" }).success).toBe(false); // modelTier
    expect(NodeSchema.safeParse({ ...base, kind: "tool" }).success).toBe(false); // toolRef
    expect(NodeSchema.safeParse({ ...base, kind: "gate" }).success).toBe(false); // gate policy
    expect(NodeSchema.safeParse({ ...base, kind: "router" }).success).toBe(false); // targets
    expect(NodeSchema.safeParse({ ...base, kind: "subgraph" }).success).toBe(false); // subgraphRef

    expect(NodeSchema.safeParse({ ...base, kind: "router", targets: [] }).success).toBe(false);
    expect(
      NodeSchema.safeParse({ ...base, kind: "router", targets: [{ label: "ok", to: "END" }] }).success,
    ).toBe(true);
  });
});

describe("RouteTargetSchema (ADR-3)", () => {
  it("is exactly { label, to } and offers no node-id escape hatch", () => {
    const parsed = RouteTargetSchema.parse({ label: "retry", to: "plan_draft", node: "anything" });
    expect(Object.keys(parsed).sort()).toEqual(["label", "to"]);
    expect(RouteTargetSchema.safeParse({ label: "", to: "x" }).success).toBe(false);
    expect(RouteTargetSchema.safeParse({ to: "x" }).success).toBe(false);
  });
});

describe("SubgraphDeclSchema (ADR-5)", () => {
  const base = {
    id: "sprint",
    graphId: "fixture.sprint",
    depth: 1,
    entryGate: "in",
    exitGate: "out",
    persistence: "inherit",
  };

  it("makes a nested checkpointer unrepresentable", () => {
    expect(SubgraphDeclSchema.parse(base).persistence).toBe("inherit");
    const own = SubgraphDeclSchema.safeParse({ ...base, persistence: "own" });
    expect(own.success).toBe(false);
    if (own.success) return;
    expect(own.error.issues[0]?.path).toEqual(["persistence"]);
  });

  it(`caps declared nesting depth at ${MAX_SUBGRAPH_DEPTH}`, () => {
    expect(SubgraphDeclSchema.safeParse({ ...base, depth: MAX_SUBGRAPH_DEPTH }).success).toBe(true);
    expect(SubgraphDeclSchema.safeParse({ ...base, depth: MAX_SUBGRAPH_DEPTH + 1 }).success).toBe(false);
    expect(SubgraphDeclSchema.safeParse({ ...base, depth: 0 }).success).toBe(false);
  });
});

describe("reducer registry (ADR-4)", () => {
  it("is closed and marks exactly the order-dependent reducers", () => {
    expect([...REDUCER_REFS].sort()).toEqual(
      [
        "appendById",
        "lastWriteWinsByKey",
        "listAppend",
        "maxNumber",
        "mergeLedger",
        "replaceIfNewer",
        "setUnion",
      ].sort(),
    );
    const orderDependent = REDUCER_REFS.filter((ref) => !KNOWN_REDUCERS[ref].orderInvariant).sort();
    expect(orderDependent).toEqual(["listAppend", "replaceIfNewer"]);
    const scalar = REDUCER_REFS.filter((ref) => KNOWN_REDUCERS[ref].scalar);
    expect(scalar).toEqual(["replaceIfNewer"]);
  });

  // Regression: Object.freeze does not sever the prototype chain, so a raw
  // `KNOWN_REDUCERS[ref]` resolved inherited members to truthy Object.prototype values
  // whose orderInvariant/scalar were undefined — producing a spurious second diagnostic.
  it.each(["toString", "constructor", "valueOf", "hasOwnProperty", "isPrototypeOf", "__proto__"])(
    "does not resolve the inherited member %s",
    (ref) => {
      expect(isKnownReducer(ref)).toBe(false);
      expect(reducerProperties(ref)).toBeUndefined();
    },
  );

  it("resolves every own member", () => {
    for (const ref of REDUCER_REFS) {
      expect(isKnownReducer(ref)).toBe(true);
      expect(reducerProperties(ref)).toEqual(KNOWN_REDUCERS[ref]);
    }
    expect(isKnownReducer("nope")).toBe(false);
    expect(reducerProperties("nope")).toBeUndefined();
  });
});

describe("endpoint helpers", () => {
  it("recognises only the reserved terminal", () => {
    expect(TERMINAL_ENDPOINT).toBe("END");
    expect(isTerminalEndpoint("END")).toBe(true);
    expect(isTerminalEndpoint("end")).toBe(false);
    expect(isTerminalEndpoint("finalize")).toBe(false);
  });
});
