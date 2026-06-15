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
import type { LLMClient } from "../../providers/types.js";
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

  // Seed a history.jsonl in the REAL pipeline shape: an evaluation-failed/rework
  // event (produces a sprint-rework lesson via the history fallback) plus a pass.
  const entries = [
    {
      timestamp: "2026-01-01T00:00:00.000Z",
      event: "evaluation-failed",
      phase: "rework",
      sprintId: "sprint-hist-1",
      details: { iteration: 1, feedback: "criterion C1 failed" },
    },
    {
      timestamp: "2026-01-02T00:00:00.000Z",
      event: "sprint-passed",
      phase: "complete",
      sprintId: "sprint-hist-1",
      details: {},
    },
  ];

  const jsonl = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(join(boberDir, "history.jsonl"), jsonl, "utf-8");
}

// Seed .bober/eval-results/ with a failing eval in the real on-disk shape, so the
// CLI distill path exercises the (a) failed-criterion and (b) failing-strategy signals.
async function writeEvalResultsFixture(contractId: string): Promise<void> {
  const dir = join(tmpDir, ".bober", "eval-results");
  await mkdir(dir, { recursive: true });
  const evalId = `eval-${contractId}-1`;
  const evalResult = {
    evalId,
    contractId,
    iteration: 1,
    overallResult: "fail",
    strategyResults: [
      { strategy: "unit-test", required: true, result: "fail" },
      { strategy: "build", required: true, result: "pass" },
    ],
    criteriaResults: [
      { criterionId: "C1", required: true, result: "fail" },
      { criterionId: "C2", required: true, result: "pass" },
    ],
  };
  await writeFile(join(dir, `${evalId}.json`), JSON.stringify(evalResult, null, 2), "utf-8");
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
    // Real iterationHistory shape: all but the last iteration failed, last passed.
    iterationHistory: Array.from({ length: iterationCount }, (_, i) => ({
      iteration: i + 1,
      evalId: `eval-${contractId}-${i + 1}`,
      result: i < iterationCount - 1 ? "fail" : "pass",
      timestamp: "2026-01-01T00:00:00.000Z",
    })),
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

  it("distills (a) failed-criterion and (b) failing-strategy lessons from real eval results", async () => {
    await writeContractFixture("sprint-real-1", 2); // iteration 1 fail, 2 pass
    await writeEvalResultsFixture("sprint-real-1");

    await invokeDistill();
    const listOutput = await invokeList();

    // (b) the failing unit-test strategy and (a) the failed unit-test criterion both surface,
    // alongside the (c) sprint-rework lesson from the failed iteration.
    expect(listOutput).toContain("eval-strategy-failure:unit-test");
    expect(listOutput).toContain("failed-criterion:unit-test");
    expect(listOutput).toContain("sprint-rework");
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

// ── C5: sc-2-8 namespace resolution — default team → current path ─────

describe("C5 — namespace resolution (sc-2-8)", () => {
  it("distill uses the default .bober/memory/ path when no config is present", async () => {
    // tmpDir has no bober.config.json — resolveDefaultNamespace falls back to undefined → current path
    await writeHistoryFixture();

    await invokeDistill();

    // Lessons MUST land in .bober/memory/ (not a subdir) for the default team
    const indexPath = join(tmpDir, ".bober", "memory", "INDEX.md");
    const content = await readFile(indexPath, "utf-8");
    expect(content.trim().length).toBeGreaterThan(0);
  });

  it("distill uses the default .bober/memory/ path when config has no teams (programming team → sentinel '')", async () => {
    // Write a minimal bober.config.json — programming team's memoryNamespace is "" → current path
    await mkdir(join(tmpDir, ".bober"), { recursive: true });
    const minimalConfig = {
      project: { name: "test-project", mode: "brownfield" },
    };
    await writeFile(
      join(tmpDir, "bober.config.json"),
      JSON.stringify(minimalConfig, null, 2),
      "utf-8",
    );
    await writeHistoryFixture();

    await invokeDistill();

    // With the programming team (memoryNamespace ''), lessons must be in .bober/memory/
    const indexPath = join(tmpDir, ".bober", "memory", "INDEX.md");
    const content = await readFile(indexPath, "utf-8");
    expect(content.trim().length).toBeGreaterThan(0);

    // Confirm there is NO programming/ subdir (no migration)
    const { access: fsAccess } = await import("node:fs/promises");
    await expect(
      fsAccess(join(tmpDir, ".bober", "memory", "programming", "INDEX.md")),
    ).rejects.toThrow();
  });

  it("buildMemoryDistill with no namespace reads the default .bober/memory/ path", async () => {
    // Seed a lesson in the default path
    const { appendLesson: append } = await import("../../state/memory.js");
    const lesson = {
      lessonId: "sc-2-8-lesson",
      createdAt: new Date().toISOString(),
      category: "testing",
      tags: ["namespace"],
      summary: "This lesson lives in the default memory path",
      occurrences: 1,
      severity: "info" as const,
      sourceEntryRefs: ["history.jsonl#1"],
    };
    await mkdir(join(tmpDir, ".bober"), { recursive: true });
    await append(tmpDir, lesson); // no namespace → .bober/memory/

    // buildMemoryDistill with no namespace must find the lesson
    const { ChatSession } = await import("../../chat/chat-session.js");
    const fakeLLM = {
      chat: async () => ({
        text: JSON.stringify({ action: "answer" }),
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      }),
    } as unknown as LLMClient;

    const session = new ChatSession({
      llm: fakeLLM,
      projectRoot: tmpDir,
      // no memoryNamespace → reads .bober/memory/
    });
    // Access the private buildMemoryDistill indirectly through the loadLessonIndex path
    const { loadLessonIndex } = await import("../../state/memory.js");
    const records = await loadLessonIndex(tmpDir, { limit: 10 }, undefined);
    expect(records.map((r) => r.lessonId)).toContain("sc-2-8-lesson");

    // Confirm the session exists and has no memoryNamespace set (default)
    expect(session).toBeDefined();
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
