/**
 * Tests for `agent-bober blackboard publish|read` CLI (sc-2-6, sc-2-7).
 * Uses the exported runBlackboardPublish/runBlackboardRead DI cores so
 * no real CLI spawning is needed. Uses real temp dirs + real bober.config.json
 * files (no fs mocks for the two-cwd visibility test — principles.md:44).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runBlackboardPublish, runBlackboardRead } from "./blackboard.js";
import { SharedBlackboard } from "../../fleet/shared-blackboard.js";

// ── Lifecycle ─────────────────────────────────────────────────────────

let tmpDir: string;
const originalExitCode = process.exitCode;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-blackboard-cli-"));
  process.exitCode = 0;
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = originalExitCode as number | undefined;
});

// ── Helpers ───────────────────────────────────────────────────────────

/** Write a minimal bober.config.json with a fleet section to a cwd dir. */
async function writeFleetConfig(
  cwdDir: string,
  subject: string,
  dbPath: string,
  namespace = "run-1",
): Promise<void> {
  const config = {
    project: { name: subject, mode: "greenfield" },
    fleet: {
      blackboardDbPath: dbPath,
      blackboardNamespace: namespace,
      blackboardSubject: subject,
      maxRounds: 3,
    },
  };
  await writeFile(join(cwdDir, "bober.config.json"), JSON.stringify(config, null, 2), "utf-8");
}

/** Write a minimal bober.config.json WITHOUT a fleet section. */
async function writeMinimalConfig(cwdDir: string): Promise<void> {
  const config = {
    project: { name: "no-fleet", mode: "greenfield" },
  };
  await writeFile(join(cwdDir, "bober.config.json"), JSON.stringify(config, null, 2), "utf-8");
}

// ── sc-2-6: publish writes finding ────────────────────────────────────

describe("runBlackboardPublish — with fleet section (sc-2-6)", () => {
  it("writes a finding that can be read back via SharedBlackboard.readAll()", async () => {
    const dbPath = join(tmpDir, "shared-facts.db");
    await writeFleetConfig(tmpDir, "child-a", dbPath);

    const nowIso = "2026-06-18T00:00:00.000Z";
    await runBlackboardPublish(tmpDir, "hello-world", {}, nowIso);

    expect(process.exitCode).not.toBe(1);

    // Verify via SharedBlackboard.readAll
    const bb = await SharedBlackboard.open({ dbPath, namespace: "run-1", maxRounds: 3 });
    try {
      const all = bb.readAll();
      expect(all.some((f) => f.value === "hello-world")).toBe(true);
      expect(all.some((f) => f.subject === "child-a")).toBe(true);
    } finally {
      bb.close();
    }
  });

  it("uses --round N when provided", async () => {
    const dbPath = join(tmpDir, "shared-round.db");
    await writeFleetConfig(tmpDir, "child-b", dbPath);

    const nowIso = "2026-06-18T00:01:00.000Z";
    await runBlackboardPublish(tmpDir, "round-2-finding", { round: "2" }, nowIso);

    expect(process.exitCode).not.toBe(1);

    const bb = await SharedBlackboard.open({ dbPath, namespace: "run-1", maxRounds: 3 });
    try {
      const all = bb.readAll();
      expect(all.some((f) => f.value === "round-2-finding")).toBe(true);
    } finally {
      bb.close();
    }
  });
});

// ── sc-2-6: no-fleet-section error path ──────────────────────────────

describe("runBlackboardPublish — no fleet section (sc-2-6)", () => {
  it("prints a message, sets exitCode=1, and does not throw when no fleet section", async () => {
    const cwdDir = await mkdtemp(join(tmpdir(), "bober-bb-no-fleet-"));
    try {
      await writeMinimalConfig(cwdDir);

      const stderrWrites: string[] = [];
      vi.spyOn(process.stderr, "write").mockImplementation((data: unknown) => {
        stderrWrites.push(String(data));
        return true;
      });

      let threw = false;
      try {
        await runBlackboardPublish(cwdDir, "x", {});
      } catch {
        threw = true;
      }

      expect(threw).toBe(false);
      expect(process.exitCode).toBe(1);
      expect(stderrWrites.some((s) => s.includes("No fleet section"))).toBe(true);
    } finally {
      await rm(cwdDir, { recursive: true, force: true });
    }
  });
});

// ── sc-2-7: read prints findings ─────────────────────────────────────

describe("runBlackboardRead — with fleet section (sc-2-7)", () => {
  it("prints all findings with --all flag", async () => {
    const dbPath = join(tmpDir, "shared-read.db");
    const cwdRead = await mkdtemp(join(tmpdir(), "bober-bb-read-"));
    try {
      // Publish from tmpDir as child-a
      await writeFleetConfig(tmpDir, "child-a", dbPath);
      await runBlackboardPublish(tmpDir, "finding-from-a", {}, "2026-06-18T10:00:00.000Z");

      // Set up a reader in cwdRead as child-b pointing to same db
      await writeFleetConfig(cwdRead, "child-b", dbPath);

      const stdoutWrites: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((data: unknown) => {
        stdoutWrites.push(String(data));
        return true;
      });

      await runBlackboardRead(cwdRead, { all: true });

      expect(process.exitCode).not.toBe(1);
      const output = stdoutWrites.join("");
      expect(output).toContain("finding-from-a");
      expect(output).toContain("child-a");
    } finally {
      await rm(cwdRead, { recursive: true, force: true });
    }
  });

  it("prints only sibling findings (not self) without --all", async () => {
    const dbPath = join(tmpDir, "shared-siblings.db");
    const cwdB = await mkdtemp(join(tmpdir(), "bober-bb-siblings-"));
    try {
      // Publish from tmpDir as child-a
      await writeFleetConfig(tmpDir, "child-a", dbPath);
      await runBlackboardPublish(tmpDir, "sibling-finding", {}, "2026-06-18T11:00:00.000Z");

      // Also publish from cwdB as child-b
      await writeFleetConfig(cwdB, "child-b", dbPath);
      await runBlackboardPublish(cwdB, "own-finding", {}, "2026-06-18T11:01:00.000Z");

      const stdoutWrites: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((data: unknown) => {
        stdoutWrites.push(String(data));
        return true;
      });

      // Read from cwdB (child-b) without --all — should see child-a's finding, not own
      await runBlackboardRead(cwdB, { all: false });

      const output = stdoutWrites.join("");
      expect(output).toContain("sibling-finding");
      expect(output).toContain("child-a");
      // Should NOT include child-b's own finding (siblings only)
      expect(output).not.toContain("own-finding");
    } finally {
      await rm(cwdB, { recursive: true, force: true });
    }
  });

  it("exits 0 with no output when no findings exist", async () => {
    const dbPath = join(tmpDir, "empty-read.db");
    await writeFleetConfig(tmpDir, "child-empty", dbPath);

    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((data: unknown) => {
      stdoutWrites.push(String(data));
      return true;
    });

    await runBlackboardRead(tmpDir, { all: true });

    expect(process.exitCode).not.toBe(1);
    // No findings — nothing printed
    const output = stdoutWrites.filter((s) => s.startsWith("[")).join("");
    expect(output).toBe("");
  });
});

// ── sc-2-7: no-fleet-section error path for read ──────────────────────

describe("runBlackboardRead — no fleet section (sc-2-7)", () => {
  it("prints a message, sets exitCode=1, and does not throw when no fleet section", async () => {
    const cwdDir = await mkdtemp(join(tmpdir(), "bober-bb-read-no-fleet-"));
    try {
      await writeMinimalConfig(cwdDir);

      const stderrWrites: string[] = [];
      vi.spyOn(process.stderr, "write").mockImplementation((data: unknown) => {
        stderrWrites.push(String(data));
        return true;
      });

      let threw = false;
      try {
        await runBlackboardRead(cwdDir, {});
      } catch {
        threw = true;
      }

      expect(threw).toBe(false);
      expect(process.exitCode).toBe(1);
      expect(stderrWrites.some((s) => s.includes("No fleet section"))).toBe(true);
    } finally {
      await rm(cwdDir, { recursive: true, force: true });
    }
  });
});

// ── sc-2-7: two-cwd shared visibility ─────────────────────────────────

describe("two-cwd shared visibility (sc-2-7)", () => {
  it("publish from cwd-A, read from cwd-B sees A's finding (path from config, not cwd)", async () => {
    // Single shared db path (absolute)
    const sharedDb = join(tmpDir, "shared-visibility.db");
    const cwdA = await mkdtemp(join(tmpdir(), "bober-bb-cwd-a-"));
    const cwdB = await mkdtemp(join(tmpdir(), "bober-bb-cwd-b-"));
    try {
      // Two completely different cwds, both pointing at the SAME sharedDb
      await writeFleetConfig(cwdA, "agent-a", sharedDb, "shared-ns");
      await writeFleetConfig(cwdB, "agent-b", sharedDb, "shared-ns");

      const nowIso = "2026-06-18T12:00:00.000Z";

      // Publish from A
      await runBlackboardPublish(cwdA, "hello-from-a", {}, nowIso);
      expect(process.exitCode).not.toBe(1);

      // Verify via SharedBlackboard directly (not via CLI read to avoid stdout spy conflicts)
      const verify = await SharedBlackboard.open({ dbPath: sharedDb, namespace: "shared-ns", maxRounds: 3 });
      try {
        const all = verify.readAll();
        expect(all.some((f) => f.value === "hello-from-a")).toBe(true);
      } finally {
        verify.close();
      }
    } finally {
      await rm(cwdA, { recursive: true, force: true });
      await rm(cwdB, { recursive: true, force: true });
    }
  });
});
