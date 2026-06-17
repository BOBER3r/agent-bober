/**
 * Tests for `bober medical whoop sync` CLI branches (sc-3-5, sc-3-6, sc-3-8).
 * Uses runWhoopSync() directly (exported helper) with injected deps so no real
 * network or clock is needed. vi.mock covers loadConfig + WhoopTokenStore.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HealthDataStore } from "../../medical/health-store.js";
import type { WhoopClient, WhoopCollection, WhoopPage, SyncWindow } from "../../medical/whoop/whoop-client.js";
import type { BoberConfig } from "../../config/schema.js";

// ── Vitest module mocks ───────────────────────────────────────────────

vi.mock("../../config/loader.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("../../medical/whoop/whoop-token.js", () => ({
  WhoopTokenStore: vi.fn(),
}));

// ── Fixture helpers ───────────────────────────────────────────────────

function makeConfig(deviceConnection: boolean): BoberConfig {
  return {
    project: { name: "test", mode: "greenfield" },
    medical: { egress: { deviceConnection, cloudInference: false, literatureRetrieval: false } },
  } as unknown as BoberConfig;
}

/** Fake WhoopClient with fixture pages — no network (sc-3-8). */
function fakeWhoopClient(pages: Partial<Record<WhoopCollection, WhoopPage[]>>): WhoopClient {
  const cursors: Partial<Record<WhoopCollection, number>> = {};
  return {
    async fetchPage(collection: WhoopCollection, _window: SyncWindow, _cursor?: string): Promise<WhoopPage> {
      const idx = cursors[collection] ?? 0;
      cursors[collection] = idx + 1;
      const collectionPages = pages[collection] ?? [];
      return collectionPages[idx] ?? { records: [] };
    },
  } as unknown as WhoopClient;
}

// ── Lifecycle ─────────────────────────────────────────────────────────

let tmpDir: string;
const originalExitCode = process.exitCode;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-medical-cli-"));
  process.exitCode = 0;
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
  process.exitCode = originalExitCode as number | undefined;
  // Clean env vars set in tests
  delete process.env["WHOOP_CLIENT_ID"];
  delete process.env["WHOOP_CLIENT_SECRET"];
});

// ── sc-3-5: axis off ─────────────────────────────────────────────────

describe("bober medical whoop sync — axis off (sc-3-5)", () => {
  it("prints 'device-connection egress not enabled' and sets exitCode=1 without HTTP", async () => {
    const { loadConfig } = await import("../../config/loader.js");
    vi.mocked(loadConfig).mockResolvedValue(makeConfig(false));

    const { WhoopTokenStore } = await import("../../medical/whoop/whoop-token.js");
    const mockTokenStore = {
      clientCredentials: vi.fn(),
      readRefreshToken: vi.fn(),
    };
    vi.mocked(WhoopTokenStore).mockImplementation(() => mockTokenStore as unknown as InstanceType<typeof WhoopTokenStore>);

    const stderrWrites: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const fixtureClient = fakeWhoopClient({});
    const fetchPageSpy = vi.spyOn(fixtureClient, "fetchPage");

    const { runWhoopSync } = await import("./medical.js");
    await runWhoopSync(tmpDir, {}, { client: fixtureClient, nowIso: "2026-06-17T12:00:00Z" });

    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();

    // Clear message and exit code
    expect(stderrWrites.join("")).toContain("device-connection egress not enabled");
    expect(process.exitCode).toBe(1);

    // WhoopClient must NOT have been called (no HTTP)
    expect(fetchPageSpy).not.toHaveBeenCalled();

    // WhoopTokenStore should also not have been called for credentials
    expect(mockTokenStore.clientCredentials).not.toHaveBeenCalled();
  });
});

// ── sc-3-6: credential and token branches ────────────────────────────

describe("bober medical whoop sync — credential/token branches (sc-3-6)", () => {
  it("prints 'set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET' and exits 1 when env vars unset", async () => {
    const { loadConfig } = await import("../../config/loader.js");
    vi.mocked(loadConfig).mockResolvedValue(makeConfig(true));

    const { WhoopTokenStore } = await import("../../medical/whoop/whoop-token.js");
    const mockTokenStore = {
      clientCredentials: vi.fn().mockImplementation(() => {
        throw new Error(
          "WHOOP credentials missing — set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET environment variables and try again.",
        );
      }),
      readRefreshToken: vi.fn(),
    };
    vi.mocked(WhoopTokenStore).mockImplementation(() => mockTokenStore as unknown as InstanceType<typeof WhoopTokenStore>);

    const stderrWrites: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const { runWhoopSync } = await import("./medical.js");
    await runWhoopSync(tmpDir, {}, { nowIso: "2026-06-17T12:00:00Z" });

    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();

    expect(stderrWrites.join("")).toContain("WHOOP_CLIENT_ID");
    expect(stderrWrites.join("")).toContain("WHOOP_CLIENT_SECRET");
    expect(process.exitCode).toBe(1);
  });

  it("prints 'authorize first' and exits 1 when refresh token is absent", async () => {
    const { loadConfig } = await import("../../config/loader.js");
    vi.mocked(loadConfig).mockResolvedValue(makeConfig(true));

    const { WhoopTokenStore } = await import("../../medical/whoop/whoop-token.js");
    const mockTokenStore = {
      clientCredentials: vi.fn().mockReturnValue({ clientId: "id", clientSecret: "secret" }),
      readRefreshToken: vi.fn().mockResolvedValue(undefined), // no stored token
    };
    vi.mocked(WhoopTokenStore).mockImplementation(() => mockTokenStore as unknown as InstanceType<typeof WhoopTokenStore>);

    const stderrWrites: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const { runWhoopSync } = await import("./medical.js");
    await runWhoopSync(tmpDir, {}, { nowIso: "2026-06-17T12:00:00Z" });

    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();

    const stderr = stderrWrites.join("");
    expect(stderr).toMatch(/authoris|authorize/i);
    expect(process.exitCode).toBe(1);
  });
});

// ── sc-3-8: success path ──────────────────────────────────────────────

describe("bober medical whoop sync — success path (sc-3-8)", () => {
  it("prints recordsParsed and newRows, calls store.close(), writes ingest audit entry", async () => {
    const { loadConfig } = await import("../../config/loader.js");
    vi.mocked(loadConfig).mockResolvedValue(makeConfig(true));

    const { WhoopTokenStore } = await import("../../medical/whoop/whoop-token.js");
    const mockTokenStore = {
      clientCredentials: vi.fn().mockReturnValue({ clientId: "id", clientSecret: "secret" }),
      readRefreshToken: vi.fn().mockResolvedValue("fake-refresh-token"),
    };
    vi.mocked(WhoopTokenStore).mockImplementation(() => mockTokenStore as unknown as InstanceType<typeof WhoopTokenStore>);

    // Ensure .bober/medical exists for the store
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(tmpDir, ".bober", "medical"), { recursive: true });

    const stdoutWrites: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // Spy on HealthDataStore.prototype.close to verify it gets called
    const closeSpy = vi.spyOn(HealthDataStore.prototype, "close");

    const fixtureClient = fakeWhoopClient({
      recovery: [
        {
          records: [
            {
              id: "r1",
              tStartIso: "2026-06-16T08:00:00Z",
              metrics: { recovery_score: 85, resting_heart_rate: 52 },
            },
          ],
        },
      ],
    });

    const { runWhoopSync } = await import("./medical.js");
    const fixedNow = "2026-06-17T12:00:00.000Z";
    await runWhoopSync(tmpDir, {}, { client: fixtureClient, nowIso: fixedNow });

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();

    // Check output contains counts
    const stdout = stdoutWrites.join("");
    expect(stdout).toMatch(/records parsed/);
    expect(stdout).toMatch(/new rows/);

    // store.close() must have been called
    expect(closeSpy).toHaveBeenCalled();

    // Audit entry event:'ingest' must have been written
    const auditDate = fixedNow.slice(0, 10); // "2026-06-17"
    const auditPath = join(tmpDir, ".bober", "medical", `audit-${auditDate}.jsonl`);
    const auditContent = await readFile(auditPath, "utf-8");
    const lines = auditContent.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);

    const firstEntry = JSON.parse(lines[0]!) as { event: string; tIso: string };
    expect(firstEntry.event).toBe("ingest");
    expect(firstEntry.tIso).toBe(fixedNow);

    // PHI rule: no counts in audit
    expect(auditContent).not.toContain("recordsParsed");
    expect(auditContent).not.toContain("newRows");
    expect(auditContent).not.toContain("85"); // health value must not appear
  });

  it("does not throw even when sync fails (process.exitCode=1 only)", async () => {
    const { loadConfig } = await import("../../config/loader.js");
    vi.mocked(loadConfig).mockResolvedValue(makeConfig(true));

    const { WhoopTokenStore } = await import("../../medical/whoop/whoop-token.js");
    const mockTokenStore = {
      clientCredentials: vi.fn().mockReturnValue({ clientId: "id", clientSecret: "secret" }),
      readRefreshToken: vi.fn().mockResolvedValue("fake-refresh-token"),
    };
    vi.mocked(WhoopTokenStore).mockImplementation(() => mockTokenStore as unknown as InstanceType<typeof WhoopTokenStore>);

    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(join(tmpDir, ".bober", "medical"), { recursive: true }),
    );

    const stderrWrites: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const closeSpy = vi.spyOn(HealthDataStore.prototype, "close");

    // Throw on first fetchPage call
    const throwingClient = {
      async fetchPage(): Promise<WhoopPage> {
        throw new Error("network failure");
      },
    } as unknown as WhoopClient;

    const { runWhoopSync } = await import("./medical.js");

    // Must NOT throw
    await expect(runWhoopSync(tmpDir, {}, { client: throwingClient, nowIso: "2026-06-17T12:00:00Z" })).resolves.toBeUndefined();

    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();

    expect(process.exitCode).toBe(1);
    expect(stderrWrites.join("")).toContain("Failed to sync WHOOP");

    // store.close() must still be called in finally
    expect(closeSpy).toHaveBeenCalled();
  });
});

// ── Smoke test: commander tree wiring ────────────────────────────────

describe("bober medical whoop sync — commander tree wiring", () => {
  it("whoop sync command is registered and reachable via parseAsync", async () => {
    const { loadConfig } = await import("../../config/loader.js");
    vi.mocked(loadConfig).mockResolvedValue(makeConfig(false));

    const { WhoopTokenStore } = await import("../../medical/whoop/whoop-token.js");
    vi.mocked(WhoopTokenStore).mockImplementation(() => ({
      clientCredentials: vi.fn(),
      readRefreshToken: vi.fn(),
    }) as unknown as InstanceType<typeof WhoopTokenStore>);

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const fsUtils = await import("../../utils/fs.js");
    const rootSpy = vi.spyOn(fsUtils, "findProjectRoot").mockResolvedValue(tmpDir);

    try {
      const { Command } = await import("commander");
      const { registerMedicalCommand } = await import("./medical.js");
      const program = new Command();
      program.exitOverride();
      registerMedicalCommand(program);

      // Should resolve (not throw) — axis is off so it exits with 1 without HTTP
      await program.parseAsync(["node", "bober", "medical", "whoop", "sync"]);
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
      rootSpy.mockRestore();
    }

    // axis-off -> exitCode set to 1
    expect(process.exitCode).toBe(1);
  });
});
