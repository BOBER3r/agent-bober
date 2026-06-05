/**
 * Unit tests for `bober memory distill|list|show` CLI command.
 *
 * C4 — handlers invoked against a temp project seeded with a history fixture:
 *   - distill: prints count summary and writes lessons
 *   - list: prints bounded index
 *   - show: renders one lesson including sourceEntryRefs provenance
 *   - second distill run adds zero new index lines (idempotency via CLI path)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Temp directory lifecycle ──────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-memory-cmd-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── History fixture helpers ───────────────────────────────────────────

async function writeHistoryFixture(): Promise<void> {
  const boberDir = join(tmpDir, ".bober");
  await mkdir(boberDir, { recursive: true });

  // Seed a history.jsonl that includes:
  //   - 2 "failed" phase entries (will produce sprint-failed category)
  //   - 2 eval_failed evaluating entries (will produce eval-fail category)
  const entries = [
    {
      timestamp: "2026-01-01T00:00:00.000Z",
      event: "sprint_failed",
      phase: "failed",
      sprintId: "sprint-abc-1",
      details: {},
    },
    {
      timestamp: "2026-01-02T00:00:00.000Z",
      event: "sprint_failed",
      phase: "failed",
      sprintId: "sprint-abc-2",
      details: {},
    },
    {
      timestamp: "2026-01-03T00:00:00.000Z",
      event: "eval_failed",
      phase: "evaluating",
      sprintId: "sprint-abc-3",
      details: {
        verificationMethod: "unit-test",
        criterionId: "C1",
        result: "fail",
      },
    },
  ];

  const jsonl = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(join(boberDir, "history.jsonl"), jsonl, "utf-8");
}

async function writeContractFixture(
  contractId: string,
  iterationCount: number,
): Promise<void> {
  const contractsDir = join(tmpDir, ".bober", "contracts");
  await mkdir(contractsDir, { recursive: true });

  const contract = {
    contractId,
    specId: "spec-1",
    sprintNumber: 1,
    title: "Test sprint",
    description: "A test sprint for memory CLI tests",
    status: "failed",
    dependsOn: [],
    features: [],
    successCriteria: [
      {
        criterionId: "C1",
        description: "The feature must satisfy the acceptance test with deterministic output",
        verificationMethod: "unit-test",
        required: true,
      },
    ],
    nonGoals: ["Do not add unrelated features"],
    stopConditions: ["Stop when acceptance tests pass green"],
    definitionOfDone: "All tests pass and the build is green with no regressions",
    assumptions: [],
    outOfScope: [],
    iterationHistory: Array.from({ length: iterationCount }, (_, i) => ({ round: i + 1 })),
    lastEvalId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  await writeFile(
    join(contractsDir, `${contractId}.json`),
    JSON.stringify(contract, null, 2),
    "utf-8",
  );
}

// ── Helper to invoke command actions against tmpDir ────────────────────

async function invokeDistill(): Promise<string> {
  // We spy on process.stdout.write to capture output and then invoke the action.
  const writes: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });

  // Override findProjectRoot to return tmpDir
  const fsUtils = await import("../../utils/fs.js");
  const rootSpy = vi.spyOn(fsUtils, "findProjectRoot").mockResolvedValue(tmpDir);

  try {
    const { Command } = await import("commander");
    const { registerMemoryCommand } = await import("./memory.js");
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);

    await program.parseAsync(["node", "bober", "memory", "distill"]);
  } finally {
    stdoutSpy.mockRestore();
    rootSpy.mockRestore();
  }

  return writes.join("");
}

async function invokeList(): Promise<string> {
  const writes: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });

  const fsUtils = await import("../../utils/fs.js");
  const rootSpy = vi.spyOn(fsUtils, "findProjectRoot").mockResolvedValue(tmpDir);

  try {
    const { Command } = await import("commander");
    const { registerMemoryCommand } = await import("./memory.js");
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);

    await program.parseAsync(["node", "bober", "memory", "list"]);
  } finally {
    stdoutSpy.mockRestore();
    rootSpy.mockRestore();
  }

  return writes.join("");
}

async function invokeShow(lessonId: string): Promise<string> {
  const writes: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });

  const fsUtils = await import("../../utils/fs.js");
  const rootSpy = vi.spyOn(fsUtils, "findProjectRoot").mockResolvedValue(tmpDir);

  try {
    const { Command } = await import("commander");
    const { registerMemoryCommand } = await import("./memory.js");
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);

    await program.parseAsync(["node", "bober", "memory", "show", lessonId]);
  } finally {
    stdoutSpy.mockRestore();
    rootSpy.mockRestore();
  }

  return writes.join("");
}

// ── C4: Command registration ──────────────────────────────────────────

describe("C4 — command registration", () => {
  it("registers memory command with distill, list, show subcommands", async () => {
    const { Command } = await import("commander");
    const { registerMemoryCommand } = await import("./memory.js");
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program);

    const memCmd = program.commands.find((c) => c.name() === "memory");
    expect(memCmd).toBeDefined();

    const subNames = memCmd!.commands.map((c) => c.name());
    expect(subNames).toEqual(expect.arrayContaining(["distill", "list", "show"]));
  });
});

// ── C4: distill prints count summary ─────────────────────────────────

describe("C4 — distill handler", () => {
  it("prints 'distilled N lessons (M new)' summary", async () => {
    await writeHistoryFixture();
    await writeContractFixture("sprint-churn-1", 3); // >= threshold

    const output = await invokeDistill();

    expect(output).toContain("distilled");
    expect(output).toMatch(/\d+ lessons/);
    expect(output).toMatch(/\(\d+ new\)/);
  });

  it("distilled lessons are persisted to INDEX.md", async () => {
    await writeHistoryFixture();

    await invokeDistill();

    const indexPath = join(tmpDir, ".bober", "memory", "INDEX.md");
    const content = await readFile(indexPath, "utf-8");
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it("second distill run reports 0 new lessons (idempotency via CLI)", async () => {
    await writeHistoryFixture();

    // First run
    await invokeDistill();

    const indexPath = join(tmpDir, ".bober", "memory", "INDEX.md");
    const before = await readFile(indexPath, "utf-8");
    const linesBefore = before.split("\n").filter((l) => l.trim().length > 0).length;

    // Second run — should add 0 new lines
    const output = await invokeDistill();

    const after = await readFile(indexPath, "utf-8");
    const linesAfter = after.split("\n").filter((l) => l.trim().length > 0).length;

    expect(linesAfter).toBe(linesBefore);
    expect(output).toContain("(0 new)");
  });
});

// ── C4: list prints bounded index ─────────────────────────────────────

describe("C4 — list handler", () => {
  it("prints lesson index after distilling", async () => {
    await writeHistoryFixture();

    // First distill to create lessons
    await invokeDistill();

    const output = await invokeList();

    // Should show the index header and at least one row
    expect(output).toContain("LESSON ID");
  });

  it("shows empty message when no lessons exist", async () => {
    const writes: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    const fsUtils = await import("../../utils/fs.js");
    const rootSpy = vi.spyOn(fsUtils, "findProjectRoot").mockResolvedValue(tmpDir);

    try {
      const { Command } = await import("commander");
      const { registerMemoryCommand } = await import("./memory.js");
      const program = new Command();
      program.exitOverride();
      registerMemoryCommand(program);
      await program.parseAsync(["node", "bober", "memory", "list"]);
    } finally {
      stdoutSpy.mockRestore();
      rootSpy.mockRestore();
    }

    const output = writes.join("");
    expect(output).toContain("No lessons found");
  });
});

// ── C4: show renders provenance ────────────────────────────────────────

describe("C4 — show handler", () => {
  it("renders lesson with sourceEntryRefs provenance", async () => {
    await writeHistoryFixture();

    // Distill to create lessons
    await invokeDistill();

    // Get the lessonId from the index
    const { loadLessonIndex } = await import("../../state/memory.js");
    const records = await loadLessonIndex(tmpDir, { limit: 10 });
    expect(records.length).toBeGreaterThan(0);

    const lessonId = records[0]!.lessonId;
    const output = await invokeShow(lessonId);

    expect(output).toContain(lessonId);
    expect(output).toContain("Source References");
    // Must render at least one sourceEntryRef
    expect(output).toMatch(/- .+/);
  });

  it("prints error for non-existent lessonId", async () => {
    const stderrWrites: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    const fsUtils = await import("../../utils/fs.js");
    const rootSpy = vi.spyOn(fsUtils, "findProjectRoot").mockResolvedValue(tmpDir);

    try {
      const { Command } = await import("commander");
      const { registerMemoryCommand } = await import("./memory.js");
      const program = new Command();
      program.exitOverride();
      registerMemoryCommand(program);
      await program.parseAsync(["node", "bober", "memory", "show", "nonexistent-id"]);
    } finally {
      stderrSpy.mockRestore();
      rootSpy.mockRestore();
    }

    const stderrOutput = stderrWrites.join("");
    expect(stderrOutput).toContain("nonexistent-id");
  });
});
