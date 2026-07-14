/**
 * Tests for `bober research job add|list|remove` CLI (sc-1-3).
 *
 * Strategy: call registerResearchCommand on a fresh Command() instance,
 * then invoke program.parseAsync() with inline argv to exercise the full
 * .action() handlers against a real temp directory (no filesystem mocks —
 * principles L44). Spy on process.stdout.write / process.stderr.write to
 * capture output without polluting test logs.
 *
 * process.exitCode is reset in before/afterEach (mirrors task.test.ts:17-26).
 */

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

import { registerResearchCommand } from "./research.js";
import { listJobs, addJob, jobId } from "../../research/job-store.js";
import { ResearchJobSchema } from "../../research/types.js";
import type { Finding } from "../../hub/finding.js";
import type { RoleProviderBlock } from "../../fleet/tier-policy.js";

// ── Lifecycle ─────────────────────────────────────────────────────────

let tmpRoot: string;
const originalExitCode = process.exitCode;

// We need to override findProjectRoot so the CLI uses our temp dir.
// Mock the whole module — research.ts only imports findProjectRoot from utils/fs.
vi.mock("../../utils/fs.js", () => ({
  findProjectRoot: vi.fn(),
}));

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-research-cli-"));
  process.exitCode = 0;

  // Wire findProjectRoot to return tmpRoot for every test
  const { findProjectRoot } = await import("../../utils/fs.js");
  vi.mocked(findProjectRoot).mockResolvedValue(tmpRoot);
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
  process.exitCode = originalExitCode as number | undefined;
});

// ── Helpers ───────────────────────────────────────────────────────────

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride(); // prevent commander from calling process.exit()
  registerResearchCommand(program);
  return program;
}

/** Make a program with injected run deps — avoids real provider + SQLite in tests. */
function makeProgramWithRunOverrides(
  queryModel: (b: RoleProviderBlock, p: string) => Promise<string>,
  findingSink: (f: Finding) => Promise<void>,
): Command {
  const program = new Command();
  program.exitOverride();
  registerResearchCommand(program, { queryModel, findingSink });
  return program;
}

async function parse(program: Command, args: string[]): Promise<void> {
  // { from: "node" } strips the first two elements (node binary + script path)
  // so commander processes only the subcommand args.
  await program.parseAsync(["node", "bober", ...args], { from: "node" });
}

// ── sc-1-3: add ───────────────────────────────────────────────────────

describe("research job add", () => {
  it("sc-1-3: prints job id, question, and cadence after successful add", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    const program = makeProgram();
    await parse(program, [
      "research", "job", "add",
      "--question", "What are the latest Vitest features?",
      "--cadence", "weekly",
    ]);

    const output = writes.join("");
    expect(output).toMatch(/Added research job/);
    expect(output).toMatch(/What are the latest Vitest features\?/);
    expect(output).toMatch(/weekly/);
    expect(process.exitCode).toBe(0);
  });

  it("sc-1-3: job is persisted and visible via listJobs after add", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const program = makeProgram();
    await parse(program, [
      "research", "job", "add",
      "--question", "How does ESM resolution work in Node?",
      "--cadence", "daily",
      "--domain", "coding",
    ]);

    const jobs = await listJobs(tmpRoot);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].question).toBe("How does ESM resolution work in Node?");
    expect(jobs[0].cadence).toBe("daily");
    expect(jobs[0].domain).toBe("coding");
    expect(jobs[0].onlineResearch).toBe(false);
  });

  it("sets exitCode=1 and writes to stderr when question is empty", async () => {
    const errWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errWrites.push(String(chunk));
      return true;
    });

    const program = makeProgram();
    // commander's requiredOption prevents empty --question from reaching .action;
    // bypass by directly calling addJob with an invalid payload via a no-option call
    // Instead, test that the store rejects an invalid job when question is ""
    // We can also test via parseAsync and commander's exitOverride catching missing required option
    try {
      await parse(program, ["research", "job", "add", "--question", ""]);
    } catch {
      // commander may throw (exitOverride)
    }

    // exitCode=1 set due to Zod parse failure (empty question)
    expect(process.exitCode).toBe(1);
  });
});

// ── sc-1-3: list ──────────────────────────────────────────────────────

describe("research job list", () => {
  it("sc-1-3: prints 'No research jobs defined' when empty", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    const program = makeProgram();
    await parse(program, ["research", "job", "list"]);

    expect(writes.join("")).toMatch(/No research jobs defined/);
    expect(process.exitCode).toBe(0);
  });

  it("sc-1-3: prints job id, cadence, and question after add", async () => {
    const outWrites: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      outWrites.push(String(chunk));
      return true;
    });

    // Add a job first
    const addProgram = makeProgram();
    await parse(addProgram, [
      "research", "job", "add",
      "--question", "What is the current state of Deno?",
      "--cadence", "monthly",
    ]);

    // Now list
    outWrites.length = 0;
    const listProgram = makeProgram();
    await parse(listProgram, ["research", "job", "list"]);

    const output = outWrites.join("");
    expect(output).toMatch(/What is the current state of Deno\?/);
    expect(output).toMatch(/monthly/);
    expect(process.exitCode).toBe(0);
  });
});

// ── sc-1-3: remove ────────────────────────────────────────────────────

describe("research job remove", () => {
  it("sc-1-3: deletes the job file and subsequent list omits it", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    // Add a job
    const addProgram = makeProgram();
    await parse(addProgram, [
      "research", "job", "add",
      "--question", "What changed in TypeScript 5.5?",
      "--cadence", "weekly",
    ]);

    // Get the id from the store
    const jobs = await listJobs(tmpRoot);
    expect(jobs).toHaveLength(1);
    const id = jobs[0].id;

    // Remove it
    const removeProgram = makeProgram();
    await parse(removeProgram, ["research", "job", "remove", id]);

    // List should be empty
    const remaining = await listJobs(tmpRoot);
    expect(remaining).toHaveLength(0);
    expect(process.exitCode).toBe(0);
  });

  it("sc-1-3: sets exitCode=1 when job not found", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const program = makeProgram();
    await parse(program, ["research", "job", "remove", "nonexistent-id"]);

    expect(process.exitCode).toBe(1);
  });
});

// ── sc-2-4: research run <jobId> ──────────────────────────────────────

describe("research run", () => {
  it("sc-2-4: loads the stored job, runs with injected deps, and prints the note path", async () => {
    // First, add a job
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const addProgram = makeProgram();
    await parse(addProgram, [
      "research", "job", "add",
      "--question", "What are the benefits of ESM modules?",
      "--cadence", "weekly",
    ]);

    // Get the created job id
    const jobs = await listJobs(tmpRoot);
    expect(jobs).toHaveLength(1);
    const jobId = jobs[0].id;

    // Inject fake queryModel (returns distinct answers per block) and a recording findingSink
    const sinkCalls: Finding[] = [];
    const fakeQueryModel = async (b: RoleProviderBlock, _p: string): Promise<string> =>
      `injected answer from ${b.provider}/${b.model}`;
    const fakeFindingSink = async (f: Finding): Promise<void> => { sinkCalls.push(f); };

    // Capture stdout to get the note path
    const outWrites: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      outWrites.push(String(chunk));
      return true;
    });

    const runProgram = makeProgramWithRunOverrides(fakeQueryModel, fakeFindingSink);
    await parse(runProgram, ["research", "run", jobId]);

    // sc-2-4: prints the note path
    const output = outWrites.join("");
    expect(output).toMatch(/\.md$/m);
    expect(output).toContain("research");
    expect(process.exitCode).toBe(0);

    // sc-2-4: note file actually exists and has correct content
    const notePath = output.trim();
    const noteContent = await readFile(notePath, "utf-8");
    expect(noteContent).toContain("What are the benefits of ESM modules?");

    // sc-2-4: findingSink was called exactly once (no real network hit)
    expect(sinkCalls).toHaveLength(1);
    expect(sinkCalls[0].title).toContain("ESM");
  });

  it("sc-2-4: sets exitCode=1 when job not found", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const fakeSink = async (_f: Finding): Promise<void> => {};
    const fakeQm = async (_b: RoleProviderBlock, _p: string): Promise<string> => "answer";
    const runProgram = makeProgramWithRunOverrides(fakeQm, fakeSink);
    await parse(runProgram, ["research", "run", "nonexistent-job-id"]);

    expect(process.exitCode).toBe(1);
  });
});

// ── sc-4-4: research tick CLI ─────────────────────────────────────────

describe("research tick", () => {
  it("sc-4-4: runs tick with no jobs due and reports 'no jobs due'", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    // Add a future job so there is something in the store but nothing due
    const createdAt = "2026-06-01T00:00:00.000Z";
    const question = "tick future question";
    const job = ResearchJobSchema.parse({
      id: jobId(question, createdAt),
      question,
      cadence: "weekly" as const,
      onlineResearch: false,
      createdAt,
      nextDueAt: "2099-01-01T00:00:00.000Z",
    });
    await addJob(tmpRoot, job);

    const sinkCalls: Finding[] = [];
    const fakeQm = async (_b: RoleProviderBlock, _p: string): Promise<string> => "answer";
    const fakeSink = async (f: Finding): Promise<void> => { sinkCalls.push(f); };
    const program = makeProgramWithRunOverrides(fakeQm, fakeSink);

    await parse(program, ["research", "tick"]);

    expect(process.exitCode).toBe(0);
    expect(writes.join("")).toMatch(/no jobs due/i);
    expect(sinkCalls).toHaveLength(0); // no real LLM calls
  });

  it("sc-4-4: tick runs a due job via injected queryModel and findingSink", async () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    // Add a due job (nextDueAt in the past)
    const createdAt = "2026-06-01T00:00:00.000Z";
    const question = "tick due question for CLI test";
    const job = ResearchJobSchema.parse({
      id: jobId(question, createdAt),
      question,
      cadence: "daily" as const,
      onlineResearch: false,
      createdAt,
      nextDueAt: "2026-01-01T00:00:00.000Z", // well in the past
    });
    await addJob(tmpRoot, job);

    const sinkCalls: Finding[] = [];
    const fakeQm = async (_b: RoleProviderBlock, _p: string): Promise<string> =>
      "injected answer from tick test";
    const fakeSink = async (f: Finding): Promise<void> => { sinkCalls.push(f); };
    const program = makeProgramWithRunOverrides(fakeQm, fakeSink);

    await parse(program, ["research", "tick"]);

    expect(process.exitCode).toBe(0);
    // The job ran → finding sink was invoked
    expect(sinkCalls).toHaveLength(1);
    expect(writes.join("")).toMatch(/ran 1 job/i);
  });

  it("sc-4-4: --watch flag parses without error (does not hang — we do not start the real interval)", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    // Use vi.stubGlobal to prevent the setInterval from actually running
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation(
      (() => 0) as typeof setInterval,
    );

    const fakeQm = async (_b: RoleProviderBlock, _p: string): Promise<string> => "answer";
    const fakeSink = async (_f: Finding): Promise<void> => {};
    const program = makeProgramWithRunOverrides(fakeQm, fakeSink);

    await parse(program, ["research", "tick", "--watch", "--interval", "1000"]);

    expect(process.exitCode).toBe(0);
    expect(setIntervalSpy).toHaveBeenCalledOnce();

    setIntervalSpy.mockRestore();
  });
});
