import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  LessonEntrySchema,
  appendLesson,
  loadLessonIndex,
  loadLesson,
  memoryDir,
  lessonPath,
  indexPath,
} from "./memory.js";
import type { LessonEntry } from "./memory.js";

// ── Fixtures ──────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-memory-test-"));
  // Pre-create .bober/ directory (mirrors real project layout)
  await mkdir(join(tmpDir, ".bober"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeLesson(id: string, overrides: Partial<LessonEntry> = {}): LessonEntry {
  return {
    lessonId: id,
    createdAt: new Date().toISOString(),
    category: "testing",
    tags: ["unit", "state"],
    summary: `Lesson ${id}: a concise summary of the observed pattern`,
    occurrences: 1,
    severity: "warn",
    sourceEntryRefs: ["history.jsonl#42"],
    ...overrides,
  };
}

// ── C1: LessonEntrySchema validation ──────────────────────────────────

describe("C1: LessonEntrySchema", () => {
  it("accepts a valid lesson entry", () => {
    const lesson = makeLesson("lesson-1");
    const result = LessonEntrySchema.safeParse(lesson);
    expect(result.success).toBe(true);
  });

  it("rejects a lesson with empty sourceEntryRefs array", () => {
    const lesson = makeLesson("lesson-1", { sourceEntryRefs: [] });
    const result = LessonEntrySchema.safeParse(lesson);
    expect(result.success).toBe(false);
  });

  it("rejects a lesson with missing lessonId", () => {
    const { lessonId: _unused, ...rest } = makeLesson("lesson-1");
    const result = LessonEntrySchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects a lesson with occurrences = 0 (must be positive int)", () => {
    const lesson = makeLesson("lesson-1", { occurrences: 0 });
    const result = LessonEntrySchema.safeParse(lesson);
    expect(result.success).toBe(false);
  });

  it("rejects a lesson with invalid severity", () => {
    const lesson = makeLesson("lesson-1", {
      severity: "critical" as LessonEntry["severity"],
    });
    const result = LessonEntrySchema.safeParse(lesson);
    expect(result.success).toBe(false);
  });

  it("accepts tags defaulting to empty array when not provided", () => {
    const { tags: _unused, ...rest } = makeLesson("lesson-1");
    const result = LessonEntrySchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tags).toEqual([]);
    }
  });

  it("rejects a sourceEntryRefs containing an empty string", () => {
    const lesson = makeLesson("lesson-1", { sourceEntryRefs: [""] });
    const result = LessonEntrySchema.safeParse(lesson);
    expect(result.success).toBe(false);
  });
});

// ── C2: appendLesson persists files + upserts single INDEX line ────────

describe("C2: appendLesson — files and INDEX upsert", () => {
  it("creates <lessonId>.md file", async () => {
    const lesson = makeLesson("lesson-abc");
    await appendLesson(tmpDir, lesson);

    const mdPath = join(tmpDir, ".bober", "memory", "lesson-abc.md");
    const content = await readFile(mdPath, "utf-8");
    expect(content).toContain("---");
    expect(content).toContain("lesson-abc");
  });

  it("creates INDEX.md with one line for the lesson", async () => {
    const lesson = makeLesson("lesson-abc");
    await appendLesson(tmpDir, lesson);

    const idxPath = join(tmpDir, ".bober", "memory", "INDEX.md");
    const content = await readFile(idxPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("lesson-abc");
  });

  it("appending the same lessonId twice results in exactly one INDEX line", async () => {
    const lesson = makeLesson("lesson-dup");
    await appendLesson(tmpDir, lesson);
    // Second append — same id, updated occurrences
    await appendLesson(tmpDir, { ...lesson, occurrences: 2 });

    const idxPath = join(tmpDir, ".bober", "memory", "INDEX.md");
    const content = await readFile(idxPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const matchingLines = lines.filter((l) => {
      const parts = l.split(" ");
      return parts[0] === "-" && parts[1] === "lesson-dup";
    });
    expect(matchingLines).toHaveLength(1);
    // The line should reflect the updated occurrences (x2)
    expect(matchingLines[0]).toContain("x2");
  });

  it("two distinct lessonIds produce two INDEX lines", async () => {
    await appendLesson(tmpDir, makeLesson("lesson-a"));
    await appendLesson(tmpDir, makeLesson("lesson-b"));

    const idxPath = join(tmpDir, ".bober", "memory", "INDEX.md");
    const content = await readFile(idxPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);
  });

  it("rejects an invalid lesson (empty sourceEntryRefs) before writing", async () => {
    const lesson = makeLesson("lesson-bad", { sourceEntryRefs: [] });
    await expect(appendLesson(tmpDir, lesson)).rejects.toThrow();
  });

  it("does not confuse lesson-1 with lesson-12 during upsert", async () => {
    await appendLesson(tmpDir, makeLesson("lesson-1"));
    await appendLesson(tmpDir, makeLesson("lesson-12"));
    // Now update lesson-1 only
    await appendLesson(tmpDir, makeLesson("lesson-1", { occurrences: 99 }));

    const idxPath = join(tmpDir, ".bober", "memory", "INDEX.md");
    const content = await readFile(idxPath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    // Still two distinct lines
    expect(lines).toHaveLength(2);
    // lesson-12 line is unchanged (occurrences = 1)
    const line12 = lines.find((l) => l.split(" ")[1] === "lesson-12");
    expect(line12).toBeDefined();
    expect(line12).toContain("x1");
    // lesson-1 line is updated (occurrences = 99)
    const line1 = lines.find((l) => l.split(" ")[1] === "lesson-1");
    expect(line1).toBeDefined();
    expect(line1).toContain("x99");
  });
});

// ── C3: loadLessonIndex — bounded + index-only ────────────────────────

describe("C3: loadLessonIndex — capped and index-only", () => {
  it("returns at most `limit` records", async () => {
    for (let i = 0; i < 5; i++) {
      await appendLesson(tmpDir, makeLesson(`lesson-${i}`));
    }
    const records = await loadLessonIndex(tmpDir, { limit: 2 });
    expect(records.length).toBeLessThanOrEqual(2);
    expect(records).toHaveLength(2);
  });

  it("returns all records when count is below limit", async () => {
    await appendLesson(tmpDir, makeLesson("lesson-only"));
    const records = await loadLessonIndex(tmpDir, { limit: 100 });
    expect(records).toHaveLength(1);
  });

  it("returns empty array when INDEX.md does not exist", async () => {
    const records = await loadLessonIndex(tmpDir, { limit: 10 });
    expect(records).toHaveLength(0);
  });

  it("loads index even after a <lessonId>.md file is deleted — proves index-only read", async () => {
    await appendLesson(tmpDir, makeLesson("lesson-deleted"));
    await appendLesson(tmpDir, makeLesson("lesson-kept"));

    // Delete the <id>.md to prove loadLessonIndex does not open it
    await rm(join(tmpDir, ".bober", "memory", "lesson-deleted.md"), { force: true });

    const records = await loadLessonIndex(tmpDir, { limit: 10 });
    // Both index records must still appear — index was not touched
    expect(records).toHaveLength(2);
    const ids = records.map((r) => r.lessonId);
    expect(ids).toContain("lesson-deleted");
    expect(ids).toContain("lesson-kept");
  });

  it("index records carry lessonId, category, severity, occurrences, tags, summarySnippet", async () => {
    const lesson = makeLesson("lesson-fields", {
      category: "patterns",
      severity: "high",
      occurrences: 3,
      tags: ["alpha", "beta"],
      summary: "A short summary for field verification",
    });
    await appendLesson(tmpDir, lesson);

    const records = await loadLessonIndex(tmpDir, { limit: 1 });
    expect(records).toHaveLength(1);
    const rec = records[0];
    expect(rec.lessonId).toBe("lesson-fields");
    expect(rec.category).toBe("patterns");
    expect(rec.severity).toBe("high");
    expect(rec.occurrences).toBe(3);
    expect(rec.tags).toContain("alpha");
    expect(rec.tags).toContain("beta");
    expect(rec.summarySnippet).toContain("A short summary");
  });
});

// ── C4: loadLesson round-trip + provenance invariant ─────────────────

describe("C4: loadLesson — round-trip and provenance", () => {
  it("round-trips a persisted lesson with equality", async () => {
    const lesson = makeLesson("lesson-rt");
    await appendLesson(tmpDir, lesson);
    const back = await loadLesson(tmpDir, lesson.lessonId);
    expect(back).toEqual(lesson);
  });

  it("round-trips a lesson with multiple tags and sourceEntryRefs", async () => {
    const lesson = makeLesson("lesson-multi", {
      tags: ["tag-a", "tag-b", "tag-c"],
      sourceEntryRefs: ["history.jsonl#1", "history.jsonl#2", "history.jsonl#3"],
      occurrences: 5,
      severity: "high",
    });
    await appendLesson(tmpDir, lesson);
    const back = await loadLesson(tmpDir, lesson.lessonId);
    expect(back).toEqual(lesson);
  });

  it("provenance invariant: loaded lesson has non-empty sourceEntryRefs", async () => {
    const lesson = makeLesson("lesson-provenance");
    await appendLesson(tmpDir, lesson);
    const back = await loadLesson(tmpDir, lesson.lessonId);
    expect(back.sourceEntryRefs.length).toBeGreaterThan(0);
  });

  it("round-trips a lesson with no tags (default empty array)", async () => {
    const { tags: _unused, ...rest } = makeLesson("lesson-notags");
    const parsed = LessonEntrySchema.parse(rest);
    await appendLesson(tmpDir, parsed);
    const back = await loadLesson(tmpDir, parsed.lessonId);
    expect(back.tags).toEqual([]);
    expect(back).toEqual(parsed);
  });

  it("throws a descriptive error when lesson file does not exist", async () => {
    await expect(loadLesson(tmpDir, "nonexistent-lesson")).rejects.toThrow(
      /Lesson not found/,
    );
  });

  it("round-trips createdAt as an ISO datetime string", async () => {
    const lesson = makeLesson("lesson-datetime");
    await appendLesson(tmpDir, lesson);
    const back = await loadLesson(tmpDir, lesson.lessonId);
    expect(back.createdAt).toBe(lesson.createdAt);
  });
});

// ── C5: sc-2-4 path helper namespace resolution ───────────────────────

describe("C5: path helpers — namespace resolution (sc-2-4)", () => {
  it("memoryDir with no namespace resolves to .bober/memory", () => {
    expect(memoryDir(tmpDir)).toBe(join(tmpDir, ".bober", "memory"));
  });

  it("memoryDir with empty string resolves to .bober/memory (back-compat sentinel)", () => {
    expect(memoryDir(tmpDir, "")).toBe(join(tmpDir, ".bober", "memory"));
  });

  it("memoryDir with 'programming' resolves to .bober/memory (built-in team sentinel)", () => {
    expect(memoryDir(tmpDir, "programming")).toBe(join(tmpDir, ".bober", "memory"));
  });

  it("memoryDir with 'teamA' resolves to .bober/memory/teamA", () => {
    expect(memoryDir(tmpDir, "teamA")).toBe(join(tmpDir, ".bober", "memory", "teamA"));
  });

  it("lessonPath with no namespace resolves under .bober/memory", () => {
    expect(lessonPath(tmpDir, "my-lesson")).toBe(
      join(tmpDir, ".bober", "memory", "my-lesson.md"),
    );
  });

  it("lessonPath with 'teamA' resolves under .bober/memory/teamA", () => {
    expect(lessonPath(tmpDir, "my-lesson", "teamA")).toBe(
      join(tmpDir, ".bober", "memory", "teamA", "my-lesson.md"),
    );
  });

  it("indexPath with no namespace resolves under .bober/memory", () => {
    expect(indexPath(tmpDir)).toBe(join(tmpDir, ".bober", "memory", "INDEX.md"));
  });

  it("indexPath with 'teamA' resolves under .bober/memory/teamA", () => {
    expect(indexPath(tmpDir, "teamA")).toBe(
      join(tmpDir, ".bober", "memory", "teamA", "INDEX.md"),
    );
  });
});

// ── C6: sc-2-5 namespace isolation ───────────────────────────────────

describe("C6: namespace isolation (sc-2-5)", () => {
  it("a lesson appended under 'teamA' is visible in teamA but NOT in the default namespace", async () => {
    await appendLesson(tmpDir, makeLesson("lesson-teamA"), "teamA");

    const teamAIndex = await loadLessonIndex(tmpDir, { limit: 10 }, "teamA");
    expect(teamAIndex.map((r) => r.lessonId)).toContain("lesson-teamA");

    const defaultIndex = await loadLessonIndex(tmpDir, { limit: 10 });
    expect(defaultIndex.map((r) => r.lessonId)).not.toContain("lesson-teamA");
  });

  it("a lesson appended under the default namespace is NOT visible in 'teamA'", async () => {
    await appendLesson(tmpDir, makeLesson("lesson-default"));

    const defaultIndex = await loadLessonIndex(tmpDir, { limit: 10 });
    expect(defaultIndex.map((r) => r.lessonId)).toContain("lesson-default");

    const teamAIndex = await loadLessonIndex(tmpDir, { limit: 10 }, "teamA");
    expect(teamAIndex.map((r) => r.lessonId)).not.toContain("lesson-default");
  });

  it("teamA and teamB are isolated from each other", async () => {
    await appendLesson(tmpDir, makeLesson("lesson-a"), "teamA");
    await appendLesson(tmpDir, makeLesson("lesson-b"), "teamB");

    const teamAIndex = await loadLessonIndex(tmpDir, { limit: 10 }, "teamA");
    expect(teamAIndex.map((r) => r.lessonId)).toContain("lesson-a");
    expect(teamAIndex.map((r) => r.lessonId)).not.toContain("lesson-b");

    const teamBIndex = await loadLessonIndex(tmpDir, { limit: 10 }, "teamB");
    expect(teamBIndex.map((r) => r.lessonId)).toContain("lesson-b");
    expect(teamBIndex.map((r) => r.lessonId)).not.toContain("lesson-a");
  });
});

// ── C7: sc-2-6 back-compat / pre-existing fixture ────────────────────

describe("C7: back-compat with pre-existing fixture (sc-2-6)", () => {
  it("a lesson written via appendLesson with no namespace is loaded by no-namespace loadLessonIndex", async () => {
    const lesson = makeLesson("lesson-backcompat");
    await appendLesson(tmpDir, lesson);

    // Confirm the file is in the DEFAULT (non-namespaced) directory
    const raw = await readFile(join(tmpDir, ".bober", "memory", "lesson-backcompat.md"), "utf-8");
    expect(raw).toContain("lesson-backcompat");

    // Load via no-namespace loadLessonIndex and confirm it's returned
    const records = await loadLessonIndex(tmpDir, { limit: 10 });
    expect(records.map((r) => r.lessonId)).toContain("lesson-backcompat");
  });

  it("loadLesson with no namespace reads the lesson from the default path", async () => {
    const lesson = makeLesson("lesson-rt-backcompat");
    await appendLesson(tmpDir, lesson);

    const back = await loadLesson(tmpDir, "lesson-rt-backcompat");
    expect(back).toEqual(lesson);
  });

  it("'programming' namespace resolves identically to no namespace (round-trip)", async () => {
    const lesson = makeLesson("lesson-programming");
    await appendLesson(tmpDir, lesson, "programming");

    // Must land in .bober/memory/ (no subdir)
    const raw = await readFile(join(tmpDir, ".bober", "memory", "lesson-programming.md"), "utf-8");
    expect(raw).toContain("lesson-programming");

    // And be readable with no namespace
    const back = await loadLesson(tmpDir, "lesson-programming");
    expect(back).toEqual(lesson);
  });
});
