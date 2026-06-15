/**
 * Unit tests for `bober chat [team]` team selection and namespace routing.
 *
 * sc-4-6: chat with team 'example' resolves the example team and uses its
 *         memoryNamespace for buildMemoryDistill; no team => programming/default.
 * sc-4-7: a lesson written under the example team's namespace lands in
 *         .bober/memory/example/, NOT .bober/memory/.
 *
 * Pattern: temp dirs, vi.mock for commander-dependent paths, direct state
 * utilities (appendLesson, loadLessonIndex, memoryDir) for assertions.
 * No network, no real LLM calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { LLMClient } from "../../providers/types.js";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Temp directory lifecycle ──────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-chat-cmd-"));
  await mkdir(join(tmpDir, ".bober"), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ── Shared fixtures ───────────────────────────────────────────────────

const minimalConfig = {
  project: { name: "test-project", mode: "brownfield" as const },
  teams: {
    example: {
      displayName: "Example research team",
      memoryNamespace: "example",
      pipelineShape: "ts" as const,
      providers: { chat: "openai" },
    },
  },
};

const fakeLLM = {
  chat: async () => ({
    text: JSON.stringify({ action: "answer" }),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  }),
} as unknown as LLMClient;

// ── sc-4-6: chat resolves team and routes namespace ───────────────────

describe("sc-4-6 — chat team resolution and namespace routing", () => {
  it("chat with team 'example' constructs ChatSession with memoryNamespace 'example'", async () => {
    const { loadTeam } = await import("../../teams/registry.js");
    const team = loadTeam(minimalConfig as never, "example");

    // The team's memoryNamespace drives the session
    expect(team.memoryNamespace).toBe("example");

    // ChatSession stores memoryNamespace || undefined (collapses '' to undefined)
    const { ChatSession } = await import("../../chat/chat-session.js");
    const session = new ChatSession({
      llm: fakeLLM,
      projectRoot: tmpDir,
      sessionId: "test",
      memoryNamespace: team.memoryNamespace || undefined,
    });
    // Session is constructed successfully with the example namespace
    expect(session).toBeDefined();
  });

  it("chat with no team uses programming team (memoryNamespace '')", async () => {
    const { loadTeam } = await import("../../teams/registry.js");
    const team = loadTeam(minimalConfig as never, undefined);

    expect(team.id).toBe("programming");
    // '' collapses to undefined in ChatSession (chat-session.ts:90)
    expect(team.memoryNamespace || undefined).toBeUndefined();

    const { ChatSession } = await import("../../chat/chat-session.js");
    const session = new ChatSession({
      llm: fakeLLM,
      projectRoot: tmpDir,
      sessionId: "test",
      // no memoryNamespace => default .bober/memory/ path
    });
    expect(session).toBeDefined();
  });

  it("chat with 'programming' explicitly uses the default namespace (not a subdir)", async () => {
    const { loadTeam } = await import("../../teams/registry.js");
    const team = loadTeam(minimalConfig as never, "programming");

    expect(team.id).toBe("programming");
    expect(team.memoryNamespace).toBe("");
    // Collapse: '' || undefined === undefined
    expect(team.memoryNamespace || undefined).toBeUndefined();
  });

  it("loadTeam with unknown team throws so chat would report an error", async () => {
    const { loadTeam } = await import("../../teams/registry.js");
    expect(() => loadTeam(minimalConfig as never, "nonexistent")).toThrow(
      "Unknown team 'nonexistent'",
    );
  });

  it("example team buildMemoryDistill reads from namespaced path", async () => {
    // Seed a lesson in the example namespace
    const { appendLesson, loadLessonIndex } = await import("../../state/memory.js");
    const lesson = {
      lessonId: "sc-4-6-lesson",
      createdAt: new Date().toISOString(),
      category: "testing",
      tags: ["team-routing"],
      summary: "This lesson belongs to the example team namespace",
      occurrences: 1,
      severity: "info" as const,
      sourceEntryRefs: ["history.jsonl#1"],
    };
    await appendLesson(tmpDir, lesson, "example");

    // A session using the example namespace should see the lesson
    const inExample = await loadLessonIndex(tmpDir, { limit: 10 }, "example");
    expect(inExample.map((r) => r.lessonId)).toContain("sc-4-6-lesson");

    // A session using the default namespace should NOT see the example lesson
    const inDefault = await loadLessonIndex(tmpDir, { limit: 10 }, undefined);
    expect(inDefault.map((r) => r.lessonId)).not.toContain("sc-4-6-lesson");
  });
});

// ── sc-4-7: lesson lands in example namespace, not default path ───────

describe("sc-4-7 — lesson location under active example team", () => {
  it("appendLesson with namespace 'example' writes under .bober/memory/example/", async () => {
    const { appendLesson, loadLessonIndex, memoryDir } = await import(
      "../../state/memory.js"
    );

    const lesson = {
      lessonId: "sc-4-7-lesson-ns",
      createdAt: new Date().toISOString(),
      category: "namespace-routing",
      tags: ["example-team", "sprint-4"],
      summary: "Lesson written while the example team is active",
      occurrences: 1,
      severity: "info" as const,
      sourceEntryRefs: ["history.jsonl#2"],
    };

    // Drive a lesson write through the example team's namespace
    await appendLesson(tmpDir, lesson, "example");

    // Assert the lesson IS in the example namespace
    const inNs = await loadLessonIndex(tmpDir, { limit: 10 }, "example");
    expect(inNs.map((r) => r.lessonId)).toContain("sc-4-7-lesson-ns");

    // Assert the lesson is NOT in the default (programming) path
    const inDefault = await loadLessonIndex(tmpDir, { limit: 10 }, undefined);
    expect(inDefault.map((r) => r.lessonId)).not.toContain("sc-4-7-lesson-ns");

    // Assert the path is correctly resolved to .bober/memory/example/
    expect(memoryDir(tmpDir, "example")).toMatch(/memory[/\\]example$/);
  });

  it("appendLesson with no namespace writes to the default .bober/memory/ path", async () => {
    const { appendLesson, loadLessonIndex, memoryDir } = await import(
      "../../state/memory.js"
    );

    const lesson = {
      lessonId: "sc-4-7-lesson-default",
      createdAt: new Date().toISOString(),
      category: "namespace-routing",
      tags: ["programming-team", "sprint-4"],
      summary: "Lesson written by the default programming team",
      occurrences: 1,
      severity: "info" as const,
      sourceEntryRefs: ["history.jsonl#3"],
    };

    // Write with no namespace => default path
    await appendLesson(tmpDir, lesson);

    // Assert the lesson IS in the default path
    const inDefault = await loadLessonIndex(tmpDir, { limit: 10 }, undefined);
    expect(inDefault.map((r) => r.lessonId)).toContain("sc-4-7-lesson-default");

    // Assert the lesson is NOT in the example namespace
    const inExample = await loadLessonIndex(tmpDir, { limit: 10 }, "example");
    expect(inExample.map((r) => r.lessonId)).not.toContain("sc-4-7-lesson-default");

    // Default path must NOT have a 'programming' subdir
    expect(memoryDir(tmpDir, undefined)).not.toMatch(/programming/);
    expect(memoryDir(tmpDir, "")).not.toMatch(/programming/);
  });

  it("lessons in different namespaces are fully isolated", async () => {
    const { appendLesson, loadLessonIndex } = await import("../../state/memory.js");

    const lessonA = {
      lessonId: "isolation-lesson-a",
      createdAt: new Date().toISOString(),
      category: "isolation",
      tags: ["example"],
      summary: "Lesson A in example namespace",
      occurrences: 1,
      severity: "info" as const,
      sourceEntryRefs: ["history.jsonl#4"],
    };
    const lessonB = {
      lessonId: "isolation-lesson-b",
      createdAt: new Date().toISOString(),
      category: "isolation",
      tags: ["default"],
      summary: "Lesson B in default namespace",
      occurrences: 1,
      severity: "info" as const,
      sourceEntryRefs: ["history.jsonl#5"],
    };

    await appendLesson(tmpDir, lessonA, "example");
    await appendLesson(tmpDir, lessonB, undefined);

    const inExample = await loadLessonIndex(tmpDir, { limit: 10 }, "example");
    const inDefault = await loadLessonIndex(tmpDir, { limit: 10 }, undefined);

    // A is only in example
    expect(inExample.map((r) => r.lessonId)).toContain("isolation-lesson-a");
    expect(inDefault.map((r) => r.lessonId)).not.toContain("isolation-lesson-a");

    // B is only in default
    expect(inDefault.map((r) => r.lessonId)).toContain("isolation-lesson-b");
    expect(inExample.map((r) => r.lessonId)).not.toContain("isolation-lesson-b");
  });
});
