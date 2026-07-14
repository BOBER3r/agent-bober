/**
 * Tests for research-note.ts — PURE serializer, no fs/network.
 * Covers: frontmatter fields, citation flattening, path derivation.
 */

import { describe, it, expect } from "vitest";
import { serializeResearchNote, researchNotePath } from "./research-note.js";
import { parseFrontmatter } from "../../vault/frontmatter.js";
import type { MedicalAnswer } from "../types.js";
import { join } from "node:path";

const NOW = "2026-06-28T12:00:00.000Z";

const GROUNDED_ANSWER: MedicalAnswer = {
  body: "LDL cholesterol is the primary marker for cardiovascular risk.",
  abstained: false,
  citations: [
    {
      title: "Cholesterol — MedlinePlus",
      url: "https://medlineplus.gov/cholesterol.html",
      source: "medlineplus",
    },
    {
      title: "LDL: The Bad Cholesterol",
      url: "https://medlineplus.gov/ldlthebadcholesterol.html",
      source: "medlineplus",
    },
  ],
  disclaimerFooter:
    "General wellness information only — not medical advice. [disclaimer v1.0.0]",
  shortCircuit: false,
};

describe("researchNotePath", () => {
  it("places the note under <vaultDir>/research/<YYYY-MM-DD>-<marker>.md", () => {
    const path = researchNotePath("/vault", "ldl", NOW);
    expect(path).toBe(join("/vault", "research", "2026-06-28-ldl.md"));
  });

  it("slices only the date portion from the ISO string", () => {
    const path = researchNotePath("/vault", "a1c", "2025-01-15T08:30:00.000Z");
    expect(path).toBe(join("/vault", "research", "2025-01-15-a1c.md"));
  });
});

describe("serializeResearchNote", () => {
  it("produces a string parseable by parseFrontmatter", () => {
    const note = serializeResearchNote("ldl", GROUNDED_ANSWER, NOW);
    expect(note).toContain("---");
    const { frontmatter, body } = parseFrontmatter(note);
    expect(frontmatter).toBeDefined();
    expect(body.length).toBeGreaterThan(0);
  });

  it("includes required citation frontmatter fields (sc-5-3)", () => {
    const note = serializeResearchNote("ldl", GROUNDED_ANSWER, NOW);
    const { frontmatter } = parseFrontmatter(note);

    // scalar source field
    expect(frontmatter["source"]).toBe("medlineplus");

    // flattened citation arrays
    expect(frontmatter["citationTitles"]).toEqual([
      "Cholesterol — MedlinePlus",
      "LDL: The Bad Cholesterol",
    ]);
    expect(frontmatter["citationUrls"]).toEqual([
      "https://medlineplus.gov/cholesterol.html",
      "https://medlineplus.gov/ldlthebadcholesterol.html",
    ]);
  });

  it("sets domain, type, marker, status frontmatter fields", () => {
    const note = serializeResearchNote("ldl", GROUNDED_ANSWER, NOW);
    const { frontmatter } = parseFrontmatter(note);

    expect(frontmatter["domain"]).toBe("medical");
    expect(frontmatter["type"]).toBe("research");
    expect(frontmatter["marker"]).toBe("ldl");
    expect(frontmatter["status"]).toBe("open");
  });

  it("sets surfacedAt to the injected now string (never wall-clock)", () => {
    const note = serializeResearchNote("ldl", GROUNDED_ANSWER, NOW);
    const { frontmatter } = parseFrontmatter(note);
    expect(frontmatter["surfacedAt"]).toBe(NOW);
  });

  it("does NOT render [object Object] for citation values", () => {
    const note = serializeResearchNote("ldl", GROUNDED_ANSWER, NOW);
    expect(note).not.toContain("[object Object]");
  });

  it("includes the answer body in the note body", () => {
    const note = serializeResearchNote("ldl", GROUNDED_ANSWER, NOW);
    expect(note).toContain(GROUNDED_ANSWER.body);
  });

  it("includes the disclaimerFooter in the note body", () => {
    const note = serializeResearchNote("ldl", GROUNDED_ANSWER, NOW);
    expect(note).toContain(GROUNDED_ANSWER.disclaimerFooter);
  });

  it("includes the url from citations in the serialized note", () => {
    const note = serializeResearchNote("ldl", GROUNDED_ANSWER, NOW);
    expect(note).toContain("https://medlineplus.gov/cholesterol.html");
  });
});
