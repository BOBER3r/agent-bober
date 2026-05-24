/**
 * Separate tests for graph CLI commands — disabled-graph path.
 *
 * Uses static vi.mock to inject config that has graph.enabled=false.
 * Verifies s10-c6: all 3 commands exit 1 with the standard disabled message.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { Command } from "commander";

// ── Static mocks ──────────────────────────────────────────────────────────────

vi.mock("../../src/utils/fs.js", () => ({
  findProjectRoot: vi.fn().mockResolvedValue("/fake/project"),
  fileExists: vi.fn().mockResolvedValue(false),
  ensureDir: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/config/loader.js", () => ({
  loadConfig: vi.fn().mockResolvedValue({
    graph: { enabled: false },
  }),
}));

vi.mock("../../src/graph/prereq.js", () => ({
  TokensavePrereqCheck: vi.fn().mockImplementation(() => ({
    check: vi.fn().mockResolvedValue({ ok: false, reason: "MISSING", hint: "brew install aovestdipaperino/tap/tokensave" }),
  })),
}));

vi.mock("../../src/graph/artifact-store.js", () => ({
  GraphArtifactStore: vi.fn().mockImplementation(() => ({
    ensureLayout: vi.fn().mockResolvedValue(undefined),
    readManifest: vi.fn().mockResolvedValue(null),
    writeManifest: vi.fn().mockResolvedValue(undefined),
    staleness: vi.fn().mockResolvedValue({ stale: false }),
  })),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const DISABLED_MSG = "Graph integration is disabled";

function captureStderr(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((msg: string | Uint8Array) => {
    messages.push(typeof msg === "string" ? msg : msg.toString());
    return true;
  });
  return {
    messages,
    restore: () => spy.mockRestore(),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("graph commands — disabled graph path (s10-c6)", () => {
  beforeEach(() => {
    process.exitCode = undefined;
  });
  afterEach(() => {
    process.exitCode = undefined;
  });

  it("graph init exits 1 with disabled message when graph.enabled=false", async () => {
    const { messages, restore } = captureStderr();
    try {
      const { registerGraphCommand } = await import("../../src/cli/commands/graph.js");
      const prog = new Command();
      prog.exitOverride();
      registerGraphCommand(prog);

      try {
        await prog.parseAsync(["node", "test", "graph", "init"]);
      } catch {
        // Commander exitOverride throws on process.exit
      }

      expect(process.exitCode).toBe(1);
      expect(messages.some((m) => m.includes(DISABLED_MSG))).toBe(true);
    } finally {
      restore();
    }
  });

  it("graph sync exits 1 with disabled message when graph.enabled=false", async () => {
    const { messages, restore } = captureStderr();
    try {
      const { registerGraphCommand } = await import("../../src/cli/commands/graph.js");
      const prog = new Command();
      prog.exitOverride();
      registerGraphCommand(prog);

      try {
        await prog.parseAsync(["node", "test", "graph", "sync"]);
      } catch {
        // Commander exitOverride
      }

      expect(process.exitCode).toBe(1);
      expect(messages.some((m) => m.includes(DISABLED_MSG))).toBe(true);
    } finally {
      restore();
    }
  });

  it("graph status exits 1 with disabled message when graph.enabled=false", async () => {
    const { messages, restore } = captureStderr();
    try {
      const { registerGraphCommand } = await import("../../src/cli/commands/graph.js");
      const prog = new Command();
      prog.exitOverride();
      registerGraphCommand(prog);

      try {
        await prog.parseAsync(["node", "test", "graph", "status"]);
      } catch {
        // Commander exitOverride
      }

      expect(process.exitCode).toBe(1);
      expect(messages.some((m) => m.includes(DISABLED_MSG))).toBe(true);
    } finally {
      restore();
    }
  });

  it("onboard exits 1 with disabled message when graph.enabled=false", async () => {
    const { messages, restore } = captureStderr();
    try {
      const { registerOnboardCommand } = await import("../../src/cli/commands/onboard.js");
      const prog = new Command();
      prog.exitOverride();
      registerOnboardCommand(prog);

      try {
        await prog.parseAsync(["node", "test", "onboard"]);
      } catch {
        // Commander exitOverride
      }

      expect(process.exitCode).toBe(1);
      expect(messages.some((m) => m.includes(DISABLED_MSG))).toBe(true);
    } finally {
      restore();
    }
  });

  it("impact exits 1 with disabled message when graph.enabled=false", async () => {
    const { messages, restore } = captureStderr();
    try {
      const { registerImpactCommand } = await import("../../src/cli/commands/impact.js");
      const prog = new Command();
      prog.exitOverride();
      registerImpactCommand(prog);

      try {
        await prog.parseAsync(["node", "test", "impact", "sandboxPath"]);
      } catch {
        // Commander exitOverride
      }

      expect(process.exitCode).toBe(1);
      expect(messages.some((m) => m.includes(DISABLED_MSG))).toBe(true);
    } finally {
      restore();
    }
  });
});
