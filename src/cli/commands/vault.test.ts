/**
 * Tests for `bober vault reindex` CLI command (sc-3-2, sc-3-3, sc-3-4).
 *
 * Drives runVaultReindex() directly (exported core) with an injected projectRoot
 * and fixture vault directory — no process spawning, no network.
 * Mirrors the patterns established in medical.test.ts (exit-code, no-throw, close)
 * and note-io.test.ts (temp dir, writeNote fixture builder).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Lifecycle ─────────────────────────────────────────────────────────

let tmpDir: string;
const originalExitCode = process.exitCode;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-vault-cli-"));
  process.exitCode = 0;
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  process.exitCode = originalExitCode as number | undefined;
});

// ── sc-3-3: success path ─────────────────────────────────────────────

describe("bober vault reindex — success path (sc-3-3)", () => {
  it("reindexes a fixture vault into the namespace facts.db with counts > 0", async () => {
    // Build fixture vault notes using writeNote from Sprint 1
    const { writeNote } = await import("../../vault/note-io.js");
    const vaultDir = join(tmpDir, "kb");
    await writeNote({
      frontmatter: { id: "p1", drug: "metformin", dose: "500mg" },
      body: "",
      path: join(vaultDir, "p1.md"),
    });
    await writeNote({
      frontmatter: { id: "p2", drug: "aspirin" },
      body: "",
      path: join(vaultDir, "p2.md"),
    });

    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    // Run the extracted core against the temp project root (no config => ns undefined)
    const { runVaultReindex } = await import("./vault.js");
    const summary = await runVaultReindex(
      tmpDir,
      { scope: "medical", vault: vaultDir },
      { nowIso: "2026-06-28T00:00:00.000Z" },
    );

    stdoutSpy.mockRestore();

    // Summary counts must be > 0
    expect(summary).toBeDefined();
    expect(summary!.notesParsed).toBeGreaterThan(0);
    expect(summary!.factsAdded).toBeGreaterThan(0);

    // facts.db at the namespace path must contain the expected active facts
    // ns = undefined (no config file) => .bober/memory/facts.db
    const { FactStore, factsDbPath } = await import("../../state/facts.js");
    const store = new FactStore(factsDbPath(tmpDir, undefined));
    try {
      const active = store.getActiveFacts("medical");
      expect(active.length).toBeGreaterThan(0);
      expect(
        active.some((f) => f.predicate === "drug" && f.value === "metformin"),
      ).toBe(true);
    } finally {
      store.close();
    }

    expect(process.exitCode).toBe(0);
  });
});

// ── sc-3-4: missing vault ─────────────────────────────────────────────

describe("bober vault reindex — missing vault (sc-3-4)", () => {
  it("sets exitCode=1, writes red stderr, does not throw, and closes the store", async () => {
    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((c) => {
        stderrWrites.push(String(c));
        return true;
      });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    const { FactStore } = await import("../../state/facts.js");
    const closeSpy = vi.spyOn(FactStore.prototype, "close");

    const { runVaultReindex } = await import("./vault.js");

    // Must NOT reject (mirrors medical.test.ts:282)
    await expect(
      runVaultReindex(
        tmpDir,
        { scope: "medical", vault: join(tmpDir, "does-not-exist") },
        { nowIso: "2026-06-28T00:00:00.000Z" },
      ),
    ).resolves.toBeUndefined();

    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();

    // Non-zero exit code
    expect(process.exitCode).toBe(1);

    // Red error message on stderr
    expect(stderrWrites.join("")).toMatch(/Failed to reindex vault/);

    // Store was constructed (ensureFactsDir + FactStore happen before the vault check)
    // and closed in the finally block
    expect(closeSpy).toHaveBeenCalled();
  });
});

// ── sc-3-2: commander tree wiring ────────────────────────────────────

describe("bober vault reindex — commander wiring (sc-3-2)", () => {
  it("vault reindex subcommand is registered with --scope and --vault options", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    const fsUtils = await import("../../utils/fs.js");
    const rootSpy = vi
      .spyOn(fsUtils, "findProjectRoot")
      .mockResolvedValue(tmpDir);

    try {
      const { Command } = await import("commander");
      const { registerVaultCommand } = await import("./vault.js");
      const program = new Command();
      program.exitOverride();
      registerVaultCommand(program);

      // Inspect the command tree: verify vault command has reindex subcommand
      const vaultCmd = program.commands.find((c) => c.name() === "vault");
      expect(vaultCmd).toBeDefined();

      const reindexCmd = vaultCmd!.commands.find(
        (c) => c.name() === "reindex",
      );
      expect(reindexCmd).toBeDefined();

      // Verify --scope and --vault options are declared
      const optionNames = reindexCmd!.options.map((o) => o.long);
      expect(optionNames).toContain("--scope");
      expect(optionNames).toContain("--vault");

      // Smoke test: parseAsync runs without crashing (missing vault dir -> exitCode=1 ok)
      await program.parseAsync([
        "node",
        "bober",
        "vault",
        "reindex",
        "--scope",
        "medical",
        "--vault",
        join(tmpDir, "kb"),
      ]);
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
      rootSpy.mockRestore();
    }
  });
});
