import { describe, it, expect } from "vitest";
import { parseFrontmatter, serializeFrontmatter, parseNote, serializeNote } from "./frontmatter.js";

// ── Fixture ───────────────────────────────────────────────────────────

/**
 * Inline fixture containing one of each documented Dataview field type:
 *   - string  (title)
 *   - number  (weight, a float)
 *   - ISO-8601 date string (created)
 *   - block list (tags)
 *   - status enum (status — stored as plain string "active")
 */
const FIXTURE = `---
title: Test Note
weight: 5.4
created: 2026-01-01T00:00:00.000Z
tags:
  - alpha
  - beta
status: active
---

# Body

Some text here.
`;

const EXPECTED_BODY = "\n# Body\n\nSome text here.\n";

// ── sc-1-3: typed parse ──────────────────────────────────────────────

describe("parseFrontmatter (sc-1-3)", () => {
  it("parses string value", () => {
    const { frontmatter } = parseFrontmatter(FIXTURE);
    expect(typeof frontmatter.title).toBe("string");
    expect(frontmatter.title).toBe("Test Note");
  });

  it("parses number value as numeric (not string)", () => {
    const { frontmatter } = parseFrontmatter(FIXTURE);
    expect(typeof frontmatter.weight).toBe("number");
    expect(frontmatter.weight).toBe(5.4);
  });

  it("parses ISO-8601 date as a parseable string (not a Date object)", () => {
    const { frontmatter } = parseFrontmatter(FIXTURE);
    expect(typeof frontmatter.created).toBe("string");
    expect(Number.isNaN(Date.parse(frontmatter.created as string))).toBe(false);
    expect(frontmatter.created).toBe("2026-01-01T00:00:00.000Z");
  });

  it("parses block list into a string array", () => {
    const { frontmatter } = parseFrontmatter(FIXTURE);
    expect(Array.isArray(frontmatter.tags)).toBe(true);
    expect(frontmatter.tags).toEqual(["alpha", "beta"]);
  });

  it("parses status enum as a plain string", () => {
    const { frontmatter } = parseFrontmatter(FIXTURE);
    expect(frontmatter.status).toBe("active");
  });

  it("body equals the text after the closing --- delimiter, byte-for-byte", () => {
    const { body } = parseFrontmatter(FIXTURE);
    expect(body).toBe(EXPECTED_BODY);
  });

  it("input without a leading --- delimiter returns empty frontmatter and raw body", () => {
    const plain = "# No frontmatter\n\nJust body.\n";
    const { frontmatter, body } = parseFrontmatter(plain);
    expect(frontmatter).toEqual({});
    expect(body).toBe(plain);
  });

  it("parses inline list `[a, b]` into an array", () => {
    const note = `---\ntags: [alpha, beta]\n---\nbody\n`;
    const { frontmatter } = parseFrontmatter(note);
    expect(Array.isArray(frontmatter.tags)).toBe(true);
    expect(frontmatter.tags).toEqual(["alpha", "beta"]);
  });

  it("parses negative number", () => {
    const note = `---\noffset: -3.5\n---\n`;
    const { frontmatter } = parseFrontmatter(note);
    expect(typeof frontmatter.offset).toBe("number");
    expect(frontmatter.offset).toBe(-3.5);
  });
});

// ── sc-1-4: round-trip ───────────────────────────────────────────────

describe("serializeFrontmatter + parseFrontmatter round-trip (sc-1-4)", () => {
  it("serialize -> parse yields deep-equal frontmatter for all Dataview types", () => {
    const { frontmatter, body } = parseFrontmatter(FIXTURE);
    const serialized = serializeFrontmatter(frontmatter, body);
    const { frontmatter: fm2 } = parseFrontmatter(serialized);
    expect(fm2).toEqual(frontmatter);
  });

  it("body is preserved verbatim through serialize -> parse", () => {
    const { frontmatter, body } = parseFrontmatter(FIXTURE);
    const serialized = serializeFrontmatter(frontmatter, body);
    const { body: body2 } = parseFrontmatter(serialized);
    expect(body2).toBe(body);
  });
});

describe("serializeNote(parseNote(input)) round-trip (sc-1-4)", () => {
  it("serializeNote(parseNote(raw)) re-parses to frontmatter deep-equal to original", () => {
    const note = parseNote(FIXTURE, "test.md");
    const serialized = serializeNote(note);
    const note2 = parseNote(serialized, "test.md");
    expect(note2.frontmatter).toEqual(note.frontmatter);
  });

  it("path is preserved through parseNote", () => {
    const note = parseNote(FIXTURE, "/vault/notes/test.md");
    expect(note.path).toBe("/vault/notes/test.md");
  });
});
