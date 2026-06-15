/**
 * Unit tests for `bober replay capture|list|show` CLI command.
 *
 * sc-1-7 — handlers invoked against a temp project seeded with eval-result fixtures:
 *   - capture: creates .bober/replay/cases/*.json + replay.db
 *   - list: prints one row per case
 *   - show <id>: prints contractId, iteration, baselineVerdict, source path
 *   - show <bogus>: prints friendly message + sets exitCode=1, does not throw
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readdir,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Temp directory lifecycle ──────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-replay-cmd-"));
  // Reset exitCode before each test
  process.exitCode = 0;
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  // Restore exitCode
  process.exitCode = 0;
});

// ── Fixture helpers ───────────────────────────────────────────────────

async function seedEvalResult(opts: {
  contractId: string;
  iteration: number;
  passed: boolean;
  results?: unknown[];
}): Promise<void> {
  const dir = join(tmpDir, ".bober", "eval-results");
  await mkdir(dir, { recursive: true });

  const fname = `eval-${opts.contractId}-${opts.iteration}.json`;
  const payload = {
    evalId: `${opts.contractId}-${opts.iteration}`,
    contractId: opts.contractId,
    iteration: opts.iteration,
    passed: opts.passed,
    results: opts.results ?? [],
  };
  await writeFile(join(dir, fname), JSON.stringify(payload, null, 2), "utf-8");
}

// ── Helper to invoke commands against tmpDir ──────────────────────────

async function invokeCapture(replayDir = ".bober/replay"): Promise<{ stdout: string; stderr: string }> {
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
    const { registerReplayCommand } = await import("./replay.js");
    const program = new Command();
    program.exitOverride();
    registerReplayCommand(program);
    await program.parseAsync(["node", "bober", "replay", "capture", "--replay-dir", replayDir]);
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    rootSpy.mockRestore();
  }

  return { stdout: stdoutWrites.join(""), stderr: stderrWrites.join("") };
}

async function invokeList(replayDir = ".bober/replay"): Promise<{ stdout: string; stderr: string }> {
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
    const { registerReplayCommand } = await import("./replay.js");
    const program = new Command();
    program.exitOverride();
    registerReplayCommand(program);
    await program.parseAsync(["node", "bober", "replay", "list", "--replay-dir", replayDir]);
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    rootSpy.mockRestore();
  }

  return { stdout: stdoutWrites.join(""), stderr: stderrWrites.join("") };
}

async function invokeShow(
  id: string,
  replayDir = ".bober/replay",
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
    const { registerReplayCommand } = await import("./replay.js");
    const program = new Command();
    program.exitOverride();
    registerReplayCommand(program);
    await program.parseAsync(["node", "bober", "replay", "show", id, "--replay-dir", replayDir]);
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    rootSpy.mockRestore();
  }

  return { stdout: stdoutWrites.join(""), stderr: stderrWrites.join("") };
}

// ── Test suite ────────────────────────────────────────────────────────

describe("replay capture (sc-1-7)", () => {
  it("creates .bober/replay/cases/*.json and replay.db from eval-result fixture", async () => {
    await seedEvalResult({ contractId: "c1", iteration: 1, passed: true });
    await invokeCapture();

    // Check replay.db exists
    await expect(access(join(tmpDir, ".bober", "replay", "replay.db"))).resolves.toBeUndefined();

    // Check cases directory has at least one .json file
    const cases = await readdir(join(tmpDir, ".bober", "replay", "cases"));
    const jsonFiles = cases.filter((f) => f.endsWith(".json"));
    expect(jsonFiles.length).toBeGreaterThan(0);
  });

  it("prints captured case id and contract info to stdout", async () => {
    await seedEvalResult({ contractId: "c1", iteration: 1, passed: true });
    const { stdout } = await invokeCapture();
    expect(stdout).toContain("c1");
    expect(stdout).toContain("pass");
  });

  it("prints friendly message when no eval-results directory exists", async () => {
    // Don't seed anything
    const { stdout } = await invokeCapture();
    expect(stdout).toContain("No .bober/eval-results directory found");
  });

  it("prints friendly message when no eval-*.json files exist", async () => {
    // Create the directory but no files
    await mkdir(join(tmpDir, ".bober", "eval-results"), { recursive: true });
    const { stdout } = await invokeCapture();
    expect(stdout).toContain("No eval-*.json files found");
  });

  it("skips files with missing required fields without crashing", async () => {
    const dir = join(tmpDir, ".bober", "eval-results");
    await mkdir(dir, { recursive: true });
    // Write a valid file
    await writeFile(
      join(dir, "eval-c1-1.json"),
      JSON.stringify({ contractId: "c1", iteration: 1, passed: true, results: [] }),
      "utf-8",
    );
    // Write a malformed file
    await writeFile(join(dir, "eval-bad-1.json"), "NOT JSON", "utf-8");
    const { stdout } = await invokeCapture();
    // The valid file should still be captured
    expect(stdout).toContain("c1");
    expect(process.exitCode).toBe(0);
  });
});

describe("replay list (sc-1-7)", () => {
  it("prints one row per captured case", async () => {
    await seedEvalResult({ contractId: "c1", iteration: 1, passed: true });
    await invokeCapture();

    const { stdout } = await invokeList();
    expect(stdout).toContain("c1");
  });

  it("prints friendly message when no cases exist", async () => {
    // Create an empty DB by running list with no prior capture
    await mkdir(join(tmpDir, ".bober", "replay"), { recursive: true });
    // First run capture with no files to create the DB
    await invokeCapture();
    const { stdout } = await invokeList();
    expect(stdout).toContain("No replay cases found");
  });
});

describe("replay show (sc-1-7)", () => {
  it("prints contractId, iteration, baselineVerdict, and source path for a valid case", async () => {
    await seedEvalResult({ contractId: "c1", iteration: 1, passed: false });
    await invokeCapture();

    // Get the case id from list
    const { stdout: listOut } = await invokeList();
    // Extract the first id from the list output (first token in data row)
    const lines = listOut.split("\n").filter((l) => l.includes("c1") && !l.includes("CONTRACT"));
    expect(lines.length).toBeGreaterThan(0);
    const caseIdFromList = lines[0]!.trim().split(/\s+/)[0]!;

    const { stdout } = await invokeShow(caseIdFromList);
    expect(stdout).toContain("c1");
    expect(stdout).toContain("1");
    expect(stdout).toContain("fail");
    expect(stdout).toContain(caseIdFromList);
  });

  it("sets exitCode=1 and prints friendly message for unknown id — no throw", async () => {
    // Create an empty replay DB
    await mkdir(join(tmpDir, ".bober", "replay"), { recursive: true });
    await invokeCapture();

    process.exitCode = 0;
    const { stderr } = await invokeShow("bogus-unknown-id-xxx");
    expect(stderr).toContain("bogus-unknown-id-xxx");
    expect(process.exitCode).toBe(1);
  });
});

describe("replay command registration", () => {
  it("registers replay command with capture, list, show subcommands", async () => {
    const { Command } = await import("commander");
    const { registerReplayCommand } = await import("./replay.js");
    const program = new Command();
    program.exitOverride();
    registerReplayCommand(program);

    const replayCmd = program.commands.find((c) => c.name() === "replay");
    expect(replayCmd).toBeDefined();

    const subNames = replayCmd!.commands.map((c) => c.name());
    expect(subNames).toContain("capture");
    expect(subNames).toContain("list");
    expect(subNames).toContain("show");
  });
});
