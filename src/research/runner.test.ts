/**
 * Tests for src/research/runner.ts (sc-2-1 / sc-2-2 / sc-2-3).
 *
 * Uses injected fake queryModel (distinct answer per block) and a recording
 * findingSink. Writes to a real temp dir — no fs mocks (principles L44).
 */

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { parseFrontmatter } from "../vault/frontmatter.js";
import { FindingSchema } from "../hub/finding.js";
import type { Finding } from "../hub/finding.js";
import type { RoleProviderBlock } from "../fleet/tier-policy.js";
import { ResearchJobSchema } from "./types.js";
import { runResearchJob } from "./runner.js";

// ── Fixtures ──────────────────────────────────────────────────────────

const NOW = "2026-06-28T12:00:00.000Z";

const JOB = ResearchJobSchema.parse({
  id: "runnerjob0001",
  question: "What are the benefits of ESM?",
  cadence: "weekly",
  onlineResearch: false,
  createdAt: NOW,
});

const JOB_WITH_DOMAIN = ResearchJobSchema.parse({
  id: "runnerjob0002",
  question: "What is CRISPR-Cas9?",
  cadence: "monthly",
  domain: "medical",
  onlineResearch: false,
  createdAt: NOW,
});

// ── Temp dir lifecycle ────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-research-run-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────

/** Fake queryModel: returns a distinct, block-specific string. */
const queryModel = async (b: RoleProviderBlock, _p: string): Promise<string> =>
  `answer from ${b.provider}/${b.model}`;

// ── sc-2-1: >=2 distinct model labels in the written note ─────────────

describe("runResearchJob — sc-2-1 (distinct model labels)", () => {
  it("resolves >=2 distinct model labels and records them in the note", async () => {
    const calls: Finding[] = [];
    const findingSink = async (f: Finding): Promise<void> => { calls.push(f); };

    const res = await runResearchJob(JOB, { queryModel, findingSink, now: NOW, vaultRoot: tmpRoot });

    const raw = await readFile(res.notePath, "utf-8");
    const { frontmatter } = parseFrontmatter(raw);
    const models = frontmatter["models"] as string[];

    // >=2 distinct model labels
    expect(new Set(models).size).toBeGreaterThanOrEqual(2);

    // Each block's answer appears in the body
    for (const label of models) {
      expect(raw).toContain(`answer from ${label}`);
    }
  });

  it("res.models contains >=2 distinct labels", async () => {
    const findingSink = async (_f: Finding): Promise<void> => {};
    const res = await runResearchJob(JOB, { queryModel, findingSink, now: NOW, vaultRoot: tmpRoot });
    expect(new Set(res.models).size).toBeGreaterThanOrEqual(2);
  });
});

// ── sc-2-2: note frontmatter has required fields ──────────────────────

describe("runResearchJob — sc-2-2 (note frontmatter)", () => {
  it("writes a note with jobId, question, models[], and generatedAt in frontmatter", async () => {
    const findingSink = async (_f: Finding): Promise<void> => {};

    const res = await runResearchJob(JOB, { queryModel, findingSink, now: NOW, vaultRoot: tmpRoot });

    const raw = await readFile(res.notePath, "utf-8");
    const { frontmatter } = parseFrontmatter(raw);

    expect(frontmatter["jobId"]).toBe(JOB.id);
    expect(frontmatter["question"]).toBe(JOB.question);
    expect(frontmatter["generatedAt"]).toBe(NOW);
    expect(Array.isArray(frontmatter["models"])).toBe(true);
    expect((frontmatter["models"] as string[]).length).toBeGreaterThanOrEqual(2);
  });

  it("note path is under vaultRoot/research/ with YYYY-MM-DD prefix", async () => {
    const findingSink = async (_f: Finding): Promise<void> => {};
    const res = await runResearchJob(JOB, { queryModel, findingSink, now: NOW, vaultRoot: tmpRoot });

    expect(res.notePath).toContain(join(tmpRoot, "research"));
    expect(res.notePath).toContain("2026-06-28");
    expect(res.notePath.endsWith(".md")).toBe(true);
  });

  it("note models are strings (no [object Object] leakage)", async () => {
    const findingSink = async (_f: Finding): Promise<void> => {};
    const res = await runResearchJob(JOB, { queryModel, findingSink, now: NOW, vaultRoot: tmpRoot });
    const raw = await readFile(res.notePath, "utf-8");
    expect(raw).not.toContain("[object Object]");
  });
});

// ── sc-2-3: exactly one Finding with required fields ──────────────────

describe("runResearchJob — sc-2-3 (hub Finding)", () => {
  it("calls findingSink exactly once", async () => {
    const calls: Finding[] = [];
    const findingSink = async (f: Finding): Promise<void> => { calls.push(f); };

    await runResearchJob(JOB, { queryModel, findingSink, now: NOW, vaultRoot: tmpRoot });

    expect(calls).toHaveLength(1);
  });

  it("emits a Finding with domain, title, kind, evidence[], and surfacedAt", async () => {
    const calls: Finding[] = [];
    const findingSink = async (f: Finding): Promise<void> => { calls.push(f); };

    await runResearchJob(JOB, { queryModel, findingSink, now: NOW, vaultRoot: tmpRoot });

    const f = calls[0];
    expect(typeof f.domain).toBe("string");
    expect(f.domain.length).toBeGreaterThan(0);
    expect(typeof f.title).toBe("string");
    expect(["action", "watch", "risk", "question"]).toContain(f.kind);
    expect(Array.isArray(f.evidence)).toBe(true);
    expect(f.surfacedAt).toBe(NOW);
  });

  it("emitted Finding satisfies FindingSchema (validates urgency/severity/tags/status)", async () => {
    const calls: Finding[] = [];
    const findingSink = async (f: Finding): Promise<void> => { calls.push(f); };

    await runResearchJob(JOB, { queryModel, findingSink, now: NOW, vaultRoot: tmpRoot });

    // This will throw if any required field is missing or invalid
    expect(() => FindingSchema.parse(calls[0])).not.toThrow();
  });

  it("uses job.domain when present", async () => {
    const calls: Finding[] = [];
    const findingSink = async (f: Finding): Promise<void> => { calls.push(f); };

    await runResearchJob(JOB_WITH_DOMAIN, { queryModel, findingSink, now: NOW, vaultRoot: tmpRoot });

    expect(calls[0].domain).toBe("medical");
  });

  it("defaults domain to 'research' when job.domain is absent", async () => {
    const calls: Finding[] = [];
    const findingSink = async (f: Finding): Promise<void> => { calls.push(f); };

    await runResearchJob(JOB, { queryModel, findingSink, now: NOW, vaultRoot: tmpRoot });

    expect(calls[0].domain).toBe("research");
  });

  it("returns the same Finding in RunResult.finding", async () => {
    const calls: Finding[] = [];
    const findingSink = async (f: Finding): Promise<void> => { calls.push(f); };

    const res = await runResearchJob(JOB, { queryModel, findingSink, now: NOW, vaultRoot: tmpRoot });

    expect(res.finding).toEqual(calls[0]);
  });
});
