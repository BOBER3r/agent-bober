import { describe, it, expect } from "vitest";
import { noteToFacts, SUPERSEDED_STATUS } from "./index-map.js";
import type { VaultNote } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

const NOW = "2026-06-28T00:00:00.000Z";

function makeNote(
  frontmatter: Record<string, unknown>,
  path = "notes/test.md",
): VaultNote {
  return { frontmatter, body: "", path };
}

// ── sc-2-2: noteToFacts mapping ───────────────────────────────────────────────

describe("noteToFacts — sc-2-2", () => {
  it("emits one FactInput per frontmatter key with correct scope/predicate/value", () => {
    const note = makeNote({ id: "p1", drug: "metformin", dose: "500mg" });
    const facts = noteToFacts(note, { scope: "medical", now: NOW });

    expect(facts).toHaveLength(3);
    for (const f of facts) {
      expect(f.scope).toBe("medical");
      expect(f.subject).toBe("p1"); // id present -> use id
      expect(f.tValid).toBe(NOW);
      expect(f.tCreated).toBe(NOW);
      expect(f.confidence).toBe(1);
      expect(f.sourceRunId).toBeNull();
    }

    const drugFact = facts.find((f) => f.predicate === "drug");
    expect(drugFact?.value).toBe("metformin");

    const doseFact = facts.find((f) => f.predicate === "dose");
    expect(doseFact?.value).toBe("500mg");
  });

  it("uses frontmatter.id as subject when id is present", () => {
    const note = makeNote({ id: "patient-42", status: "active" });
    const facts = noteToFacts(note, { scope: "medical", now: NOW });
    expect(facts.every((f) => f.subject === "patient-42")).toBe(true);
  });

  it("falls back to note.path as subject when id is absent", () => {
    const note = makeNote({ drug: "aspirin" }, "notes/aspirin.md");
    const facts = noteToFacts(note, { scope: "medical", now: NOW });
    expect(facts).toHaveLength(1);
    expect(facts[0].subject).toBe("notes/aspirin.md");
    expect(facts[0].predicate).toBe("drug");
    expect(facts[0].value).toBe("aspirin");
  });

  it("falls back to note.path when id is empty string", () => {
    const note = makeNote({ id: "", drug: "aspirin" }, "notes/aspirin.md");
    const facts = noteToFacts(note, { scope: "medical", now: NOW });
    expect(facts.every((f) => f.subject === "notes/aspirin.md")).toBe(true);
  });

  it("stringifies arrays with JSON.stringify for stable deterministic ids", () => {
    const note = makeNote({ id: "p1", tags: ["a", "b"] });
    const facts = noteToFacts(note, { scope: "medical", now: NOW });
    const tagFact = facts.find((f) => f.predicate === "tags");
    expect(tagFact?.value).toBe(JSON.stringify(["a", "b"]));
  });

  it("stringifies numbers with String()", () => {
    const note = makeNote({ id: "p1", age: 42 });
    const facts = noteToFacts(note, { scope: "medical", now: NOW });
    const ageFact = facts.find((f) => f.predicate === "age");
    expect(ageFact?.value).toBe("42");
  });

  it("stringifies booleans with String()", () => {
    const note = makeNote({ id: "p1", active: true });
    const facts = noteToFacts(note, { scope: "medical", now: NOW });
    const activeFact = facts.find((f) => f.predicate === "active");
    expect(activeFact?.value).toBe("true");
  });

  it("skips keys with empty-stringified values (null/undefined)", () => {
    const note = makeNote({ id: "p1", nullKey: null, undefinedKey: undefined });
    const facts = noteToFacts(note, { scope: "medical", now: NOW });
    // Only the 'id' key produces a fact; null/undefined keys are skipped
    const predicates = facts.map((f) => f.predicate);
    expect(predicates).not.toContain("nullKey");
    expect(predicates).not.toContain("undefinedKey");
  });

  it("threads sourceRunId when provided", () => {
    const note = makeNote({ id: "p1", drug: "aspirin" });
    const facts = noteToFacts(note, { scope: "medical", now: NOW, sourceRunId: "run-123" });
    expect(facts.every((f) => f.sourceRunId === "run-123")).toBe(true);
  });

  it("sets sourceRunId to null when not provided", () => {
    const note = makeNote({ id: "p1", drug: "aspirin" });
    const facts = noteToFacts(note, { scope: "medical", now: NOW });
    expect(facts.every((f) => f.sourceRunId === null)).toBe(true);
  });

  it("maps status key itself when present (filtering is reindexNotes responsibility)", () => {
    const note = makeNote({ id: "p1", status: "active", drug: "aspirin" });
    const facts = noteToFacts(note, { scope: "medical", now: NOW });
    const predicates = facts.map((f) => f.predicate);
    expect(predicates).toContain("status");
    expect(predicates).toContain("drug");
  });
});

// ── SUPERSEDED_STATUS export ──────────────────────────────────────────────────

describe("SUPERSEDED_STATUS", () => {
  it("exports the string literal 'superseded'", () => {
    expect(SUPERSEDED_STATUS).toBe("superseded");
  });
});

// ── Purity test ───────────────────────────────────────────────────────────────

describe("index-map — source purity", () => {
  it("source does not call Date.now() or new Date()", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./index-map.ts", import.meta.url), "utf-8");
    const noComments = source
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n");
    expect(noComments).not.toMatch(/Date\.now\(\)/);
    expect(noComments).not.toMatch(/new Date\(\)/);
  });
});
