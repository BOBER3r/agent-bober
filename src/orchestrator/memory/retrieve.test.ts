import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendLesson } from "../../state/memory.js";
import type { LessonEntry } from "../../state/memory.js";
import { retrieveRelevantLessons, serializeLessonsForPlanner } from "./retrieve.js";

// ── Fixtures ─────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-retrieve-test-"));
  // Create only .bober/ — intentionally do NOT create history.jsonl
  await mkdir(join(tmpDir, ".bober"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function makeLesson(id: string, overrides: Partial<LessonEntry> = {}): LessonEntry {
  return {
    lessonId: id,
    createdAt: new Date().toISOString(),
    category: "eval-fail",
    tags: ["unit", "state"],
    summary: `Lesson ${id}: a concise summary of the observed pattern`,
    occurrences: 1,
    severity: "warn",
    sourceEntryRefs: ["history.jsonl#42"],
    ...overrides,
  };
}

// ── C1: topK cap + match + non-match ─────────────────────────────────

describe("C1 — retrieveRelevantLessons topK and keyword matching", () => {
  it("caps at topK and surfaces a matching lesson", async () => {
    await appendLesson(tmpDir, makeLesson("l-auth", { tags: ["auth", "login"] }));
    await appendLesson(tmpDir, makeLesson("l-db",   { tags: ["database"] }));
    await appendLesson(tmpDir, makeLesson("l-ui",   { tags: ["ui"] }));

    const out = await retrieveRelevantLessons(tmpDir, ["auth"], { topK: 1 });
    expect(out).toHaveLength(1);
    expect(out[0]!.lessonId).toBe("l-auth");
  });

  it("returns empty for a non-matching keyword", async () => {
    await appendLesson(tmpDir, makeLesson("l-auth", { tags: ["auth"] }));

    const out = await retrieveRelevantLessons(tmpDir, ["zzz-nonexistent"], { topK: 5 });
    expect(out).toEqual([]);
  });

  it("returns empty when index is empty", async () => {
    const out = await retrieveRelevantLessons(tmpDir, ["auth"], { topK: 5 });
    expect(out).toEqual([]);
  });

  it("scores against tags, category, and summarySnippet", async () => {
    // lesson with matching category (exact token "auth")
    await appendLesson(
      tmpDir,
      makeLesson("l-cat", {
        category: "auth",
        tags: ["unrelated"],
        summary: "Some lesson about unrelated things",
      }),
    );
    // lesson with matching tags
    await appendLesson(
      tmpDir,
      makeLesson("l-tag", {
        category: "other",
        tags: ["auth", "token"],
        summary: "Token refresh failure",
      }),
    );
    // lesson with no match
    await appendLesson(
      tmpDir,
      makeLesson("l-none", {
        category: "database",
        tags: ["sql"],
        summary: "SQL slow query",
      }),
    );

    const out = await retrieveRelevantLessons(tmpDir, ["auth"], { topK: 5 });
    const ids = out.map((r) => r.lessonId);
    expect(ids).toContain("l-cat");
    expect(ids).toContain("l-tag");
    expect(ids).not.toContain("l-none");
  });

  it("applies stable tiebreak by lessonId ASC when scores are equal", async () => {
    // Three lessons all with the same tag overlap
    await appendLesson(tmpDir, makeLesson("l-z", { tags: ["auth"] }));
    await appendLesson(tmpDir, makeLesson("l-a", { tags: ["auth"] }));
    await appendLesson(tmpDir, makeLesson("l-m", { tags: ["auth"] }));

    const out = await retrieveRelevantLessons(tmpDir, ["auth"], { topK: 5 });
    expect(out.map((r) => r.lessonId)).toEqual(["l-a", "l-m", "l-z"]);
  });
});

// ── C2: never reads history.jsonl ────────────────────────────────────

describe("C2 — retrieval reads INDEX.md only, never history.jsonl", () => {
  it("retrieve.ts source does not import readFile or history.ts (index-only invariant)", async () => {
    // Belt-and-suspenders: verify by source inspection that retrieve.ts has no direct
    // readFile import and no import of history.ts — it must go through loadLessonIndex.
    const src = await readFile(
      new URL("./retrieve.ts", import.meta.url),
      "utf-8",
    );
    // Must NOT import readFile directly (all fs access must go through loadLessonIndex)
    expect(src).not.toMatch(/import\s*\{[^}]*readFile[^}]*\}\s*from/);
    // Must NOT import from state/history (that is the raw history module — off-limits)
    expect(src).not.toMatch(/from ["'].*state\/history/);
    // Must import loadLessonIndex (the only permitted fs path)
    expect(src).toContain("loadLessonIndex");
  });

  it("succeeds even when .bober/history.jsonl does not exist in the project", async () => {
    // The temp dir has .bober/ but no history.jsonl — retrieval must still work.
    // A stray read of history.jsonl would throw ENOENT, making this test fail.
    await appendLesson(tmpDir, makeLesson("l-y", { tags: ["database"] }));
    const out = await retrieveRelevantLessons(tmpDir, ["database"], { topK: 5 });
    expect(out).toHaveLength(1);
    expect(out[0]!.lessonId).toBe("l-y");
  });

  it("retrieval on a project with no INDEX.md returns empty without throwing", async () => {
    // No appendLesson calls — INDEX.md does not exist; loadLessonIndex returns [].
    const out = await retrieveRelevantLessons(tmpDir, ["auth"], { topK: 5 });
    expect(out).toEqual([]);
  });
});

// ── C3: serialized block respects topK AND charBudget ────────────────

describe("C3 — serializeLessonsForPlanner respects topK and charBudget", () => {
  it("serialized block respects topK and the character budget", async () => {
    for (let i = 0; i < 10; i++) {
      await appendLesson(
        tmpDir,
        makeLesson(`l-${i}`, {
          tags: ["auth"],
          summary: "x".repeat(300),
        }),
      );
    }

    const recs = await retrieveRelevantLessons(tmpDir, ["auth"], { topK: 3 });
    expect(recs.length).toBeLessThanOrEqual(3);

    const block = serializeLessonsForPlanner(recs, { charBudget: 200 });
    expect(block.length).toBeLessThanOrEqual(200);
  });

  it("returns empty string for empty records", () => {
    const block = serializeLessonsForPlanner([]);
    expect(block).toBe("");
  });

  it("uses default charBudget when none is specified", async () => {
    // Seed one lesson with a very long summarySnippet (but summarySnippet is 80-char capped in INDEX.md)
    await appendLesson(
      tmpDir,
      makeLesson("l-long", { tags: ["auth"], summary: "y".repeat(300) }),
    );
    const recs = await retrieveRelevantLessons(tmpDir, ["auth"], { topK: 5 });
    const block = serializeLessonsForPlanner(recs);
    // Default budget is 1200 — even with a single entry it should be well under
    expect(block.length).toBeLessThanOrEqual(1200);
    expect(block.length).toBeGreaterThan(0);
  });

  it("includes all returned records in the block (within budget)", async () => {
    await appendLesson(tmpDir, makeLesson("l-1", { tags: ["auth"] }));
    await appendLesson(tmpDir, makeLesson("l-2", { tags: ["auth"] }));

    const recs = await retrieveRelevantLessons(tmpDir, ["auth"], { topK: 5 });
    const block = serializeLessonsForPlanner(recs, { charBudget: 10_000 });

    for (const r of recs) {
      expect(block).toContain(r.lessonId);
    }
  });
});

// ── C4: skill + agent reference the memory index ─────────────────────

describe("C4 — planner skill and agent reference retrieveRelevantLessons, topK, and prohibit history.jsonl", () => {
  it("skills/bober.plan/SKILL.md and agents/bober-planner.md both contain required memory index wiring", async () => {
    const skillPath = join(process.cwd(), "skills", "bober.plan", "SKILL.md");
    const agentPath = join(process.cwd(), "agents", "bober-planner.md");

    const skill = await readFile(skillPath, "utf-8");
    const agent = await readFile(agentPath, "utf-8");

    for (const [name, text] of [["SKILL.md", skill], ["bober-planner.md", agent]] as const) {
      expect(text, `${name} must reference retrieveRelevantLessons`).toContain(
        "retrieveRelevantLessons",
      );
      expect(text, `${name} must reference topK`).toMatch(/topK/);
      expect(text, `${name} must mention history.jsonl prohibition`).toMatch(
        /history\.jsonl/,
      );
    }
  });
});
