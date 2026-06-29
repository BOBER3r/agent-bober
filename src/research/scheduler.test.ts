/**
 * Tests for tick() scheduler (sc-4-2, sc-4-3).
 *
 * Strategy: use a real temp directory + real addJob/listJobs/readJob from
 * the job store (no filesystem mocks — principles L44). runJob is a spy so
 * no real LLM/network calls are made.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { addJob, listJobs, readJob, jobId } from "./job-store.js";
import { ResearchJobSchema, type ResearchJob } from "./types.js";
import { tick } from "./scheduler.js";

// ── Lifecycle ─────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-research-tick-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────

const NOW = "2026-06-15T12:00:00.000Z";

function makeJob(o: Partial<ResearchJob> & { question?: string }): ResearchJob {
  const question = o.question ?? "Q";
  const createdAt = o.createdAt ?? "2026-06-01T00:00:00.000Z";
  return ResearchJobSchema.parse({
    id: jobId(question, createdAt),
    question,
    cadence: "daily",
    onlineResearch: false,
    createdAt,
    ...o,
  });
}

function makeDeps(ran: string[], root = tmpRoot) {
  return {
    now: NOW,
    listJobs: () => listJobs(root),
    saveJob: (j: ResearchJob) => addJob(root, j),
    runJob: async (j: ResearchJob) => {
      ran.push(j.id);
    },
  };
}

// ── sc-4-2: due-only selection ────────────────────────────────────────

describe("tick — sc-4-2: due-only selection", () => {
  it("runs only jobs with nextDueAt <= now and skips jobs with nextDueAt > now", async () => {
    const due = makeJob({
      question: "due question",
      nextDueAt: "2026-06-10T00:00:00.000Z", // <= NOW
    });
    const future = makeJob({
      question: "future question",
      nextDueAt: "2026-07-01T00:00:00.000Z", // > NOW
    });

    await addJob(tmpRoot, due);
    await addJob(tmpRoot, future);

    const ran: string[] = [];
    const result = await tick(makeDeps(ran));

    expect(ran).toEqual([due.id]);
    expect(result.ran).toEqual([due.id]);
    expect(result.skipped).toContain(future.id);
    expect(result.skipped).not.toContain(due.id);
  });

  it("skips all jobs when none are due", async () => {
    const future = makeJob({
      question: "future only",
      nextDueAt: "2099-01-01T00:00:00.000Z",
    });
    await addJob(tmpRoot, future);

    const ran: string[] = [];
    const result = await tick(makeDeps(ran));

    expect(ran).toHaveLength(0);
    expect(result.ran).toHaveLength(0);
    expect(result.skipped).toContain(future.id);
  });

  it("runs a job whose nextDueAt equals now exactly (boundary inclusive)", async () => {
    const exact = makeJob({
      question: "exact boundary",
      nextDueAt: NOW, // exactly equal
    });
    await addJob(tmpRoot, exact);

    const ran: string[] = [];
    await tick(makeDeps(ran));

    expect(ran).toContain(exact.id);
  });
});

// ── sc-4-3: advancement + idempotency ────────────────────────────────

describe("tick — sc-4-3: advancement and idempotency", () => {
  it("persists lastRunAt === now and nextDueAt advanced by cadence after a run", async () => {
    const due = makeJob({
      question: "due advance",
      cadence: "daily",
      nextDueAt: "2026-06-10T00:00:00.000Z",
    });
    await addJob(tmpRoot, due);

    const ran: string[] = [];
    await tick(makeDeps(ran));

    const advanced = await readJob(tmpRoot, due.id);
    expect(advanced).not.toBeNull();
    expect(advanced?.lastRunAt).toBe(NOW);
    expect(advanced?.nextDueAt).toBe("2026-06-16T12:00:00.000Z"); // +1 day from NOW
  });

  it("a second tick at the same now fires zero runJob calls (idempotent)", async () => {
    const due = makeJob({
      question: "idempotent check",
      cadence: "daily",
      nextDueAt: "2026-06-10T00:00:00.000Z",
    });
    await addJob(tmpRoot, due);

    const ran: string[] = [];
    const deps = makeDeps(ran);

    // First tick — job should run
    await tick(deps);
    expect(ran).toHaveLength(1);

    // Second tick at the SAME now — must be a no-op
    ran.length = 0;
    const result2 = await tick(deps);
    expect(ran).toHaveLength(0);
    expect(result2.ran).toHaveLength(0);
    expect(result2.skipped).toContain(due.id);
  });

  it("advances nextDueAt for weekly cadence correctly", async () => {
    const job = makeJob({
      question: "weekly job",
      cadence: "weekly",
      nextDueAt: "2026-06-01T00:00:00.000Z",
    });
    await addJob(tmpRoot, job);

    const ran: string[] = [];
    await tick(makeDeps(ran));

    const persisted = await readJob(tmpRoot, job.id);
    expect(persisted?.nextDueAt).toBe("2026-06-22T12:00:00.000Z"); // +7 days from NOW
  });

  it("advances nextDueAt for monthly cadence correctly", async () => {
    const job = makeJob({
      question: "monthly job",
      cadence: "monthly",
      nextDueAt: "2026-06-01T00:00:00.000Z",
    });
    await addJob(tmpRoot, job);

    const ran: string[] = [];
    await tick(makeDeps(ran));

    const persisted = await readJob(tmpRoot, job.id);
    expect(persisted?.nextDueAt).toBe("2026-07-15T12:00:00.000Z"); // +1 month from NOW
  });
});

// ── undefined nextDueAt → due immediately ────────────────────────────

describe("tick — undefined nextDueAt", () => {
  it("a job with no nextDueAt is due on the first tick", async () => {
    const fresh = makeJob({ question: "fresh no due date" }); // nextDueAt undefined
    await addJob(tmpRoot, fresh);

    const ran: string[] = [];
    await tick(makeDeps(ran));

    expect(ran).toHaveLength(1);
    expect(ran[0]).toBe(fresh.id);
  });

  it("after first tick the fresh job has lastRunAt and nextDueAt set", async () => {
    const fresh = makeJob({ question: "fresh then advanced" });
    await addJob(tmpRoot, fresh);

    const ran: string[] = [];
    await tick(makeDeps(ran));

    const persisted = await readJob(tmpRoot, fresh.id);
    expect(persisted?.lastRunAt).toBe(NOW);
    expect(typeof persisted?.nextDueAt).toBe("string");
  });
});

// ── multiple due jobs all run ─────────────────────────────────────────

describe("tick — multiple due jobs", () => {
  it("runs all due jobs and returns their ids in ran array", async () => {
    const j1 = makeJob({ question: "job one", nextDueAt: "2026-06-01T00:00:00.000Z" });
    const j2 = makeJob({ question: "job two", nextDueAt: "2026-06-05T00:00:00.000Z" });
    const j3 = makeJob({ question: "job three future", nextDueAt: "2099-01-01T00:00:00.000Z" });

    await addJob(tmpRoot, j1);
    await addJob(tmpRoot, j2);
    await addJob(tmpRoot, j3);

    const ran: string[] = [];
    const result = await tick(makeDeps(ran));

    expect(ran).toContain(j1.id);
    expect(ran).toContain(j2.id);
    expect(ran).not.toContain(j3.id);
    expect(result.ran).toHaveLength(2);
    expect(result.skipped).toEqual([j3.id]);
  });
});
