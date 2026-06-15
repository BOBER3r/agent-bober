/**
 * Unit tests for `bober evolve` CLI command.
 *
 * sc-4-8: registration test + dry-run handler:
 *   - evolve command is registered with --role, --seed, --dry-run options
 *   - `--dry-run` exits 0, prints the promotion decision, writes no promoted/<role>.md
 *
 * Pattern mirrors src/cli/commands/replay.test.ts (invokeCapture / process.exitCode discipline).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Temp directory lifecycle ───────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-evolve-cmd-"));
  process.exitCode = 0;
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  process.exitCode = 0;
  vi.restoreAllMocks();
});

// ── Seed helpers ───────────────────────────────────────────────────────────────

/** Create a minimal agents/bober-generator.md so loadAgentDefinition succeeds. */
async function seedAgentFile(role: "generator" | "evaluator"): Promise<void> {
  const agentDir = join(tmpDir, "agents");
  await mkdir(agentDir, { recursive: true });
  const content = `---
name: bober-${role}
description: Test ${role} agent.
tools: []
model: sonnet
---

## Test heading

- First bullet
- Second bullet
`;
  await writeFile(join(agentDir, `bober-${role}.md`), content, "utf-8");
}

// ── invokeEvolve helper ────────────────────────────────────────────────────────

async function invokeEvolve(
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const stdoutWrites: string[] = [];
  const stderrWrites: string[] = [];

  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdoutWrites.push(String(chunk));
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderrWrites.push(String(chunk));
    return true;
  });

  const fsUtils = await import("../../utils/fs.js");
  const rootSpy = vi.spyOn(fsUtils, "findProjectRoot").mockResolvedValue(tmpDir);

  try {
    const { Command } = await import("commander");
    const { registerEvolveCommand } = await import("./evolve.js");
    const program = new Command();
    program.exitOverride();
    registerEvolveCommand(program);
    await program.parseAsync(["node", "bober", ...args]);
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    rootSpy.mockRestore();
  }

  return { stdout: stdoutWrites.join(""), stderr: stderrWrites.join("") };
}

// ── Registration test ──────────────────────────────────────────────────────────

describe("evolve command registration (sc-4-8)", () => {
  it("registers evolve command with --role, --seed, --dry-run options", async () => {
    const { Command } = await import("commander");
    const { registerEvolveCommand } = await import("./evolve.js");
    const program = new Command();
    program.exitOverride();
    registerEvolveCommand(program);

    const evolveCmd = program.commands.find((c) => c.name() === "evolve");
    expect(evolveCmd).toBeDefined();

    const optionNames = evolveCmd!.options.map((o) => o.long);
    expect(optionNames).toContain("--role");
    expect(optionNames).toContain("--seed");
    expect(optionNames).toContain("--dry-run");
  });
});

// ── Dry-run behaviour (sc-4-8) ────────────────────────────────────────────────

describe("bober evolve --dry-run (sc-4-8)", () => {
  it("exits 0, prints variants tried and promotion decision", async () => {
    await seedAgentFile("generator");
    // Create the replay directory so runReplayHarness can open (an empty) replay.db.
    await mkdir(join(tmpDir, ".bober", "replay"), { recursive: true });

    const { stdout } = await invokeEvolve([
      "evolve",
      "--role",
      "generator",
      "--dry-run",
      "--seed",
      "42",
    ]);

    expect(process.exitCode).toBe(0);
    // Must print variants tried count.
    expect(stdout).toMatch(/Variants tried:/);
    // Must print a promotion decision line.
    expect(stdout).toMatch(/Promoted|Nothing promoted/);
  });

  it("--dry-run writes no promoted/<role>.md even when corpus is empty", async () => {
    await seedAgentFile("generator");

    await invokeEvolve([
      "evolve",
      "--role",
      "generator",
      "--dry-run",
      "--seed",
      "0",
    ]);

    // No promoted file should exist anywhere under the tmp evolve dir.
    // (With no replay corpus, no variant beats a zero-improvement baseline.)
    const evolveDir = join(tmpDir, ".bober", "evolve");
    let files: string[] = [];
    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(evolveDir);
      // Check inside each runId subdirectory.
      for (const entry of entries) {
        const promotedDir = join(evolveDir, entry, "promoted");
        try {
          const promoted = await readdir(promotedDir);
          files = files.concat(promoted);
        } catch {
          // promoted/ may not exist — that's fine.
        }
      }
    } catch {
      // .bober/evolve may not exist if harness throws — also fine.
    }

    expect(files.filter((f) => f.endsWith(".md"))).toHaveLength(0);
  });

  it("handler sets exitCode=1 and does not throw on a missing agent file", async () => {
    // Do NOT seed agent file — loadAgentDefinition will throw.
    const { stderr } = await invokeEvolve([
      "evolve",
      "--role",
      "generator",
      "--dry-run",
    ]);

    // Handler must not throw; exitCode should be 1.
    expect(process.exitCode).toBe(1);
    expect(stderr).toMatch(/Failed to evolve/);
  });
});
