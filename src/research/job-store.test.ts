import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { addJob, listJobs, removeJob, readJob, jobId } from "./job-store.js";
import { ResearchJobSchema, type ResearchJob } from "./types.js";

// ── Lifecycle ─────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-research-job-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────

function makeJob(overrides: Partial<ResearchJob> = {}): ResearchJob {
  const question = overrides.question ?? "What is the current state of TypeScript?";
  const createdAt = overrides.createdAt ?? "2026-06-29T00:00:00.000Z";
  return ResearchJobSchema.parse({
    id: jobId(question, createdAt),
    question,
    cadence: "weekly",
    onlineResearch: false,
    createdAt,
    ...overrides,
  });
}

// ── sc-1-1: schema validation ─────────────────────────────────────────

describe("ResearchJobSchema", () => {
  it("sc-1-1: rejects an empty question", () => {
    const result = ResearchJobSchema.safeParse({
      id: "x",
      question: "",
      cadence: "weekly",
      createdAt: "2026-06-29T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("sc-1-1: accepts a valid job with all optional fields", () => {
    const result = ResearchJobSchema.safeParse({
      id: "abc123",
      question: "How does TypeScript resolve modules?",
      cadence: "daily",
      tier: "hard",
      modelSet: ["claude-opus-4", "deepseek-chat"],
      targetRepo: "microsoft/TypeScript",
      domain: "coding",
      onlineResearch: true,
      createdAt: "2026-06-29T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.onlineResearch).toBe(true);
      expect(result.data.tier).toBe("hard");
      expect(result.data.modelSet).toEqual(["claude-opus-4", "deepseek-chat"]);
    }
  });

  it("sc-1-1: defaults onlineResearch to false when omitted", () => {
    const result = ResearchJobSchema.safeParse({
      id: "x",
      question: "Is Bun stable?",
      cadence: "monthly",
      createdAt: "2026-06-29T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.onlineResearch).toBe(false);
    }
  });

  it("sc-1-1: rejects invalid cadence", () => {
    const result = ResearchJobSchema.safeParse({
      id: "x",
      question: "Valid question",
      cadence: "hourly",
      createdAt: "2026-06-29T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

// ── sc-1-2: store round-trip ──────────────────────────────────────────

describe("addJob / listJobs", () => {
  it("sc-1-2: list returns [] when no jobs directory exists", async () => {
    const jobs = await listJobs(tmpRoot);
    expect(jobs).toEqual([]);
  });

  it("sc-1-2: add persists JSON that round-trips and list returns it", async () => {
    const job = makeJob();
    await addJob(tmpRoot, job);

    const listed = await listJobs(tmpRoot);
    expect(listed).toHaveLength(1);
    // Full round-trip through the schema
    const reparsed = ResearchJobSchema.parse(listed[0]);
    expect(reparsed).toEqual(job);
  });

  it("sc-1-2: add validates before writing — rejects an invalid job", async () => {
    const badJob = { id: "x", question: "", cadence: "weekly", createdAt: "2026-06-29T00:00:00.000Z", onlineResearch: false } as ResearchJob;
    await expect(addJob(tmpRoot, badJob)).rejects.toThrow("Invalid research job");
    // Nothing was written
    const listed = await listJobs(tmpRoot);
    expect(listed).toHaveLength(0);
  });

  it("sc-1-2: multiple jobs are all returned by list", async () => {
    const job1 = makeJob({ question: "Question A", createdAt: "2026-06-29T00:00:00.000Z" });
    const job2 = makeJob({ question: "Question B", createdAt: "2026-06-29T01:00:00.000Z" });
    await addJob(tmpRoot, job1);
    await addJob(tmpRoot, job2);

    const listed = await listJobs(tmpRoot);
    expect(listed).toHaveLength(2);
  });
});

// ── readJob ───────────────────────────────────────────────────────────

describe("readJob", () => {
  it("returns null for a nonexistent job", async () => {
    const result = await readJob(tmpRoot, "nonexistent");
    expect(result).toBeNull();
  });

  it("returns the job after add", async () => {
    const job = makeJob();
    await addJob(tmpRoot, job);
    const got = await readJob(tmpRoot, job.id);
    expect(got).toEqual(job);
  });
});

// ── removeJob ─────────────────────────────────────────────────────────

describe("removeJob", () => {
  it("sc-1-2: remove deletes the file and list omits it", async () => {
    const job = makeJob();
    await addJob(tmpRoot, job);

    const removed = await removeJob(tmpRoot, job.id);
    expect(removed).toBe(true);

    const listed = await listJobs(tmpRoot);
    expect(listed).toHaveLength(0);
  });

  it("returns false when job does not exist", async () => {
    const result = await removeJob(tmpRoot, "ghost-id");
    expect(result).toBe(false);
  });
});

// ── jobId ─────────────────────────────────────────────────────────────

describe("jobId", () => {
  it("is deterministic — same inputs produce same id", () => {
    const q = "Why is the sky blue?";
    const ts = "2026-06-29T00:00:00.000Z";
    expect(jobId(q, ts)).toBe(jobId(q, ts));
  });

  it("produces different ids for different inputs", () => {
    const ts = "2026-06-29T00:00:00.000Z";
    expect(jobId("Q1", ts)).not.toBe(jobId("Q2", ts));
    expect(jobId("Q1", ts)).not.toBe(jobId("Q1", "2026-06-30T00:00:00.000Z"));
  });

  it("produces a 16-char hex string", () => {
    const id = jobId("test", "2026-06-29T00:00:00.000Z");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});
