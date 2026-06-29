/**
 * Tests for src/research/note-writer.ts (PURE serializer).
 *
 * Verifies: frontmatter fields, path shape, and model label list.
 * Uses parseFrontmatter to round-trip the output (no fs access — pure in/out).
 */

import { describe, it, expect } from "vitest";
import { parseFrontmatter } from "../vault/frontmatter.js";
import { researchNotePath, serializeResearchNote } from "./note-writer.js";
import { ResearchJobSchema } from "./types.js";

const NOW = "2026-06-28T12:00:00.000Z";

const JOB = ResearchJobSchema.parse({
  id: "testjob000001",
  question: "What are the latest Vitest features?",
  cadence: "weekly",
  onlineResearch: false,
  createdAt: NOW,
});

const JOB_WITH_DOMAIN = ResearchJobSchema.parse({
  id: "testjob000002",
  question: "What is the state of CRISPR?",
  cadence: "monthly",
  domain: "medical",
  onlineResearch: false,
  createdAt: NOW,
});

const LABELS = ["openai-compat/deepseek", "openai-compat/grok"];
const CONTRIBUTIONS = [
  { label: "openai-compat/deepseek", text: "DeepSeek answer about Vitest" },
  { label: "openai-compat/grok", text: "Grok answer about Vitest" },
];

// ── researchNotePath ──────────────────────────────────────────────────

describe("researchNotePath", () => {
  it("produces a YYYY-MM-DD prefixed path under vaultRoot/research/", () => {
    const path = researchNotePath("/vault", "abc123", NOW);
    expect(path).toMatch(/\/vault\/research\/2026-06-28-abc123\.md$/);
  });

  it("slices date from injected now — never wall-clock", () => {
    const path = researchNotePath("/vault", "marker", "2025-01-15T08:00:00.000Z");
    expect(path).toMatch(/2025-01-15-marker\.md$/);
  });
});

// ── serializeResearchNote ─────────────────────────────────────────────

describe("serializeResearchNote", () => {
  it("sc-2-2: frontmatter contains jobId, question, models[], and generatedAt", () => {
    const raw = serializeResearchNote(JOB, LABELS, CONTRIBUTIONS, NOW);
    const { frontmatter } = parseFrontmatter(raw);

    expect(frontmatter["jobId"]).toBe("testjob000001");
    expect(frontmatter["question"]).toBe("What are the latest Vitest features?");
    expect(frontmatter["generatedAt"]).toBe(NOW);
    expect(Array.isArray(frontmatter["models"])).toBe(true);
    expect(frontmatter["models"]).toEqual(LABELS);
  });

  it("models is a string[] (no [object Object] leakage)", () => {
    const raw = serializeResearchNote(JOB, LABELS, CONTRIBUTIONS, NOW);
    expect(raw).not.toContain("[object Object]");
    const { frontmatter } = parseFrontmatter(raw);
    const models = frontmatter["models"] as string[];
    for (const m of models) {
      expect(typeof m).toBe("string");
    }
  });

  it("body records each model label as a section header", () => {
    const raw = serializeResearchNote(JOB, LABELS, CONTRIBUTIONS, NOW);
    expect(raw).toContain("openai-compat/deepseek");
    expect(raw).toContain("openai-compat/grok");
    expect(raw).toContain("DeepSeek answer about Vitest");
    expect(raw).toContain("Grok answer about Vitest");
  });

  it("uses domain from job when present", () => {
    const raw = serializeResearchNote(JOB_WITH_DOMAIN, LABELS, CONTRIBUTIONS, NOW);
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter["domain"]).toBe("medical");
  });

  it("defaults domain to 'research' when job.domain is undefined", () => {
    const raw = serializeResearchNote(JOB, LABELS, CONTRIBUTIONS, NOW);
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter["domain"]).toBe("research");
  });

  it("starts with a YAML frontmatter block (---)", () => {
    const raw = serializeResearchNote(JOB, LABELS, CONTRIBUTIONS, NOW);
    expect(raw.startsWith("---\n")).toBe(true);
  });
});
