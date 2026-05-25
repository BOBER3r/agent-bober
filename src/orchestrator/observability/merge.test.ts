/**
 * Unit tests for mergeObsTools and supporting functions (Sprint 16).
 *
 * Uses mocked ExternalMcpServer to test namespace prefixing, error isolation,
 * and Promise.allSettled behavior without spawning real subprocesses.
 *
 * Integration tests using a real fixture MCP server live in:
 *   tests/orchestrator/observability-mcp.test.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ObservabilityProvider } from "../../config/schema.js";
import type { ExternalMcpServer as ExternalMcpServerType } from "../../mcp/external-client.js";

// ── ExternalMcpServer mock ────────────────────────────────────────────────

// We track instances created during each test.
const instances: MockServer[] = [];

interface MockServer {
  name: string;
  started: boolean;
  stopped: boolean;
  tools: { name: string; description?: string }[];
  startShouldFail: boolean;
  startError?: string;
  start: () => Promise<void>;
  listTools: () => Promise<{ name: string; description?: string }[]>;
  stop: () => Promise<void>;
}

function makeInstance(provider: ObservabilityProvider): MockServer {
  const inst: MockServer = {
    name: provider.name,
    started: false,
    stopped: false,
    tools: [{ name: "query", description: `default tool` }],
    startShouldFail: false,
    startError: undefined,
    async start() {
      if (this.startShouldFail) {
        throw new Error(this.startError ?? `provider "${this.name}" startup failed`);
      }
      this.started = true;
    },
    async listTools() {
      return this.tools;
    },
    async stop() {
      this.stopped = true;
    },
  };
  instances.push(inst);
  return inst;
}

vi.mock("../../mcp/external-client.js", () => ({
  ExternalMcpServer: vi.fn().mockImplementation((provider: ObservabilityProvider) => {
    return makeInstance(provider);
  }),
}));

import { ExternalMcpServer } from "../../mcp/external-client.js";
import { mergeObsTools, stopAll, namespaceToolName } from "./merge.js";

// Helper type alias for casting mock instances.
type AnyMcpServer = ExternalMcpServerType;

function asAny(s: AnyMcpServer): MockServer {
  return s as unknown as MockServer;
}

function provider(
  name: string,
  overrides: Partial<ObservabilityProvider> = {},
): ObservabilityProvider {
  return {
    name,
    kind: "logs",
    mcpCommand: "node",
    enabled: true,
    ...overrides,
  };
}

function restoreDefaultMock(): void {
  vi.mocked(ExternalMcpServer).mockImplementation((p: ObservabilityProvider) => {
    return makeInstance(p) as unknown as ExternalMcpServerType;
  });
}

describe("namespaceToolName()", () => {
  it("produces obs__<provider>__<tool> format", () => {
    expect(namespaceToolName("datadog", "query_logs")).toBe("obs__datadog__query_logs");
    expect(namespaceToolName("sentry", "query_events")).toBe("obs__sentry__query_events");
  });
});

describe("mergeObsTools()", () => {
  beforeEach(() => {
    instances.length = 0;
    vi.clearAllMocks();
    restoreDefaultMock();
  });

  it("merges tools from a single provider with obs__ prefix", async () => {
    const { tools, failures } = await mergeObsTools([provider("loki")]);
    // Default mock tool is "query"
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("obs__loki__query");
    expect(tools[0].upstreamName).toBe("query");
    expect(tools[0].providerName).toBe("loki");
    expect(failures).toEqual({});
  });

  it("namespaces tools from multiple providers (s16-c6 — collision prevention)", async () => {
    // Both providers define a "query" tool — they must get distinct namespaced names.
    const { tools, failures } = await mergeObsTools([
      provider("provA"),
      provider("provB"),
    ]);
    expect(failures).toEqual({});
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["obs__provA__query", "obs__provB__query"]);
  });

  it("isolates a single provider failure — other providers succeed (s16-c4)", async () => {
    let instanceIndex = 0;
    vi.mocked(ExternalMcpServer).mockImplementation((p: ObservabilityProvider) => {
      const inst = makeInstance(p);
      if (instanceIndex === 1) {
        // Second provider ("bad") should fail.
        inst.startShouldFail = true;
        inst.startError = `provider "bad" network unreachable`;
      }
      instanceIndex++;
      return inst as unknown as ExternalMcpServerType;
    });

    const { tools, failures } = await mergeObsTools([
      provider("good"),
      provider("bad"),
    ]);

    expect(tools.map((t) => t.name)).toEqual(["obs__good__query"]);
    expect(failures.bad).toBeTruthy();
    expect(failures.good).toBeUndefined();
  });

  it("all-failure case: returns empty tools and populated failures", async () => {
    vi.mocked(ExternalMcpServer).mockImplementation((p: ObservabilityProvider) => {
      const inst = makeInstance(p);
      inst.startShouldFail = true;
      inst.startError = `"${p.name}" crashed`;
      return inst as unknown as ExternalMcpServerType;
    });

    const { tools, failures } = await mergeObsTools([
      provider("a"),
      provider("b"),
    ]);

    expect(tools).toEqual([]);
    expect(Object.keys(failures).sort()).toEqual(["a", "b"]);
  });

  it("skips disabled providers", async () => {
    const { tools } = await mergeObsTools([
      provider("active", { enabled: true }),
      provider("inactive", { enabled: false }),
    ]);
    // Only "active" should be started; "inactive" is skipped.
    expect(tools.map((t) => t.name)).toEqual(["obs__active__query"]);
    expect(instances).toHaveLength(1);
    expect(instances[0].name).toBe("active");
  });

  it("returns empty tools and no failures when providers array is empty", async () => {
    const { tools, failures, servers } = await mergeObsTools([]);
    expect(tools).toEqual([]);
    expect(failures).toEqual({});
    expect(servers).toEqual([]);
  });

  it("returns running servers for stopAll to clean up", async () => {
    const { servers } = await mergeObsTools([provider("x"), provider("y")]);
    expect(servers).toHaveLength(2);
    for (const s of servers) {
      expect(asAny(s).started).toBe(true);
    }
  });

  it("does not include failed providers in returned servers list", async () => {
    let idx = 0;
    vi.mocked(ExternalMcpServer).mockImplementation((p: ObservabilityProvider) => {
      const inst = makeInstance(p);
      if (idx === 0) inst.startShouldFail = true;
      idx++;
      return inst as unknown as ExternalMcpServerType;
    });

    const { servers, failures } = await mergeObsTools([
      provider("fail"),
      provider("pass"),
    ]);

    // Only the passing server should be in the returned list.
    expect(servers).toHaveLength(1);
    expect(asAny(servers[0]).name).toBe("pass");
    expect(Object.keys(failures)).toEqual(["fail"]);
  });

  it("sanitizes env-var-like patterns from failure messages", async () => {
    vi.mocked(ExternalMcpServer).mockImplementation((p: ObservabilityProvider) => {
      const inst = makeInstance(p);
      inst.startShouldFail = true;
      // Simulate an error message that accidentally contains an env var value.
      inst.startError = `DD_API_KEY=supersecret_token_here connection refused`;
      return inst as unknown as ExternalMcpServerType;
    });

    const { failures } = await mergeObsTools([provider("datadog")]);
    expect(failures.datadog).toBeDefined();
    // The raw secret must NOT appear in the stored failure message.
    expect(failures.datadog).not.toContain("supersecret_token_here");
    expect(failures.datadog).toContain("[redacted]");
  });
});

describe("stopAll()", () => {
  beforeEach(() => {
    instances.length = 0;
    vi.clearAllMocks();
    restoreDefaultMock();
  });

  it("calls stop() on every server", async () => {
    const { servers } = await mergeObsTools([provider("a"), provider("b")]);
    await stopAll(servers);
    for (const inst of instances) {
      expect(inst.stopped).toBe(true);
    }
  });

  it("continues stopping remaining servers when one stop() fails", async () => {
    let idx = 0;
    vi.mocked(ExternalMcpServer).mockImplementation((p: ObservabilityProvider) => {
      const inst = makeInstance(p);
      const origStop = inst.stop.bind(inst);
      if (idx === 0) {
        // First stop throws.
        inst.stop = async () => {
          inst.stopped = true;
          throw new Error("stop failed");
        };
      } else {
        inst.stop = origStop;
      }
      idx++;
      return inst as unknown as ExternalMcpServerType;
    });

    const { servers } = await mergeObsTools([provider("first"), provider("second")]);
    // Must not throw even when one stop fails.
    await expect(stopAll(servers)).resolves.toBeUndefined();
    // Both servers should have had stop() called.
    expect(instances.every((i) => i.stopped)).toBe(true);
  });

  it("is safe with an empty array", async () => {
    await expect(stopAll([])).resolves.toBeUndefined();
  });
});
