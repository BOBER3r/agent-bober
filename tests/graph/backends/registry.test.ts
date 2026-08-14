import { describe, it, expect, vi } from "vitest";
import type { BoberConfig } from "../../../src/config/schema.js";
import {
  resolveGraphBackend,
  binaryForBackend,
  KNOWN_BACKENDS,
  GraphBackendResolutionError,
  type VersionProbe,
} from "../../../src/graph/backends/registry.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeConfig(graph?: Record<string, unknown>): BoberConfig {
  return {
    project: { name: "test", mode: "brownfield" },
    planner: {},
    generator: {},
    evaluator: { strategies: [] },
    sprint: {},
    pipeline: {},
    commands: {},
    ...(graph !== undefined ? { graph } : {}),
  } as unknown as BoberConfig;
}

describe("KNOWN_BACKENDS", () => {
  it("lists tokensave first, then code-review-graph (preference order)", () => {
    expect(KNOWN_BACKENDS.map((b) => b.id)).toEqual(["tokensave", "code-review-graph"]);
  });
});

describe("resolveGraphBackend — auto-detect (graph.backend unset)", () => {
  it("returns tokensave when only tokensave is detected", async () => {
    const probe: VersionProbe = vi.fn(async (binary: string) =>
      binary === "tokensave" ? { ok: true, version: "6.1.1" } : { ok: false },
    );
    const backend = await resolveGraphBackend(makeConfig({ enabled: true }), { probe });
    expect(backend.id).toBe("tokensave");
  });

  it("returns code-review-graph when only code-review-graph is detected", async () => {
    const probe: VersionProbe = vi.fn(async (binary: string) =>
      binary === "code-review-graph" ? { ok: true, version: "1.0.0" } : { ok: false },
    );
    const backend = await resolveGraphBackend(makeConfig({ enabled: true }), { probe });
    expect(backend.id).toBe("code-review-graph");
  });

  it("prefers tokensave when BOTH are detected", async () => {
    const probe: VersionProbe = vi.fn(async () => ({ ok: true, version: "1.0.0" }));
    const backend = await resolveGraphBackend(makeConfig({ enabled: true }), { probe });
    expect(backend.id).toBe("tokensave");
  });

  it("throws a combined install hint naming BOTH engines when NEITHER is detected", async () => {
    const probe: VersionProbe = vi.fn(async () => ({ ok: false }));
    expect.assertions(4);
    try {
      await resolveGraphBackend(makeConfig({ enabled: true }), { probe });
    } catch (err) {
      expect(err).toBeInstanceOf(GraphBackendResolutionError);
      const message = (err as Error).message;
      // Must name BOTH engines' install hints.
      expect(message).toContain("pip install code-review-graph");
      const tokensaveHint = KNOWN_BACKENDS[0]!.prereqSpec().installHint(process.platform);
      expect(message).toContain(tokensaveHint);
      expect(probe).toHaveBeenCalledTimes(2);
    }
  });
});

describe("resolveGraphBackend — explicit selection (graph.backend set)", () => {
  it("explicit 'tokensave' wins with NO probe call", async () => {
    const probe: VersionProbe = vi.fn(async () => ({ ok: false }));
    const backend = await resolveGraphBackend(makeConfig({ enabled: true, backend: "tokensave" }), {
      probe,
    });
    expect(backend.id).toBe("tokensave");
    expect(probe).not.toHaveBeenCalled();
  });

  it("explicit 'code-review-graph' wins with NO probe call, even though cr-graph is missing", async () => {
    const probe: VersionProbe = vi.fn(async () => ({ ok: false }));
    const backend = await resolveGraphBackend(
      makeConfig({ enabled: true, backend: "code-review-graph" }),
      { probe },
    );
    expect(backend.id).toBe("code-review-graph");
    expect(probe).not.toHaveBeenCalled();
  });

  it("explicit selection does NOT fall back to tokensave when the chosen engine is missing", async () => {
    // Even though tokensave would be "detected" by this probe, the explicit
    // selection of code-review-graph must win and must not even consult probe.
    const probe: VersionProbe = vi.fn(async (binary: string) =>
      binary === "tokensave" ? { ok: true, version: "6.1.1" } : { ok: false },
    );
    const backend = await resolveGraphBackend(
      makeConfig({ enabled: true, backend: "code-review-graph" }),
      { probe },
    );
    expect(backend.id).toBe("code-review-graph");
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("binaryForBackend", () => {
  it("uses graph.tokensavePath override for the tokensave backend", () => {
    const backend = KNOWN_BACKENDS.find((b) => b.id === "tokensave")!;
    const binary = binaryForBackend(backend, makeConfig({ tokensavePath: "/custom/tokensave" }));
    expect(binary).toBe("/custom/tokensave");
  });

  it("defaults to the backend's own binary name when no override is set", () => {
    const backend = KNOWN_BACKENDS.find((b) => b.id === "tokensave")!;
    const binary = binaryForBackend(backend, makeConfig({}));
    expect(binary).toBe("tokensave");
  });

  it("uses graph.codeReviewGraphPath override for the code-review-graph backend", () => {
    const backend = KNOWN_BACKENDS.find((b) => b.id === "code-review-graph")!;
    const binary = binaryForBackend(
      backend,
      makeConfig({ codeReviewGraphPath: "/custom/crgraph" }),
    );
    expect(binary).toBe("/custom/crgraph");
  });
});
