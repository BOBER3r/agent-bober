import { describe, it, expect } from "vitest";
import type { Finding } from "./finding.js";
import { renderPriorityMd } from "./priority-md.js";

// ── Fixtures ──────────────────────────────────────────────────────────

const T = "2026-06-28T00:00:00.000Z";
const NOW = new Date(T);

function makeFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "f-001",
    domain: "medical",
    title: "Test finding",
    kind: "action",
    urgency: 3,
    severity: 3,
    evidence: ["some evidence"],
    surfacedAt: T,
    tags: [],
    status: "open",
    ...over,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("renderPriorityMd", () => {
  it("produces YAML frontmatter with generatedAt, scope, count (sc-4-1)", () => {
    const findings = [makeFinding({ id: "f-1" }), makeFinding({ id: "f-2" })];
    const md = renderPriorityMd(findings, "general", NOW);

    expect(md).toContain("---");
    expect(md).toContain(`generatedAt: ${T}`);
    expect(md).toContain("scope: general");
    expect(md).toContain("count: 2");
  });

  it("produces a table header with all seven columns (sc-4-1)", () => {
    const md = renderPriorityMd([makeFinding()], "general", NOW);
    expect(md).toContain("| rank | title | domain | kind | urgency | severity | dueBy |");
  });

  it("produces exactly one table row per finding (sc-4-1)", () => {
    const f1 = makeFinding({ id: "f-1", domain: "health", kind: "watch", urgency: 4, severity: 5 });
    const f2 = makeFinding({ id: "f-2", domain: "finance", kind: "risk", urgency: 2, severity: 3 });
    const md = renderPriorityMd([f1, f2], "general", NOW);

    // Row 1 — rank 1 column appears in the table
    expect(md).toContain("| 1 |");
    expect(md).toContain(f1.domain);
    expect(md).toContain(f1.kind);
    expect(md).toContain(`| ${f1.urgency} |`);
    expect(md).toContain(`| ${f1.severity} |`);

    // Row 2
    expect(md).toContain("| 2 |");
    expect(md).toContain(f2.domain);
    expect(md).toContain(f2.kind);
  });

  it("preserves the given order (rank = index + 1, no re-sort) (sc-4-1)", () => {
    const fa = makeFinding({ id: "fa", title: "Low urgency first", urgency: 1 });
    const fb = makeFinding({ id: "fb", title: "High urgency second", urgency: 5 });
    const md = renderPriorityMd([fa, fb], "general", NOW);

    // rank 1 row must appear before rank 2 row
    const rank1Pos = md.indexOf("| 1 |");
    const rank2Pos = md.indexOf("| 2 |");
    expect(rank1Pos).toBeGreaterThanOrEqual(0);
    expect(rank2Pos).toBeGreaterThanOrEqual(0);
    expect(rank1Pos).toBeLessThan(rank2Pos);

    // fa's title must appear in the output before fb's title
    expect(md.indexOf(fa.title)).toBeLessThan(md.indexOf(fb.title));
  });

  it("emits empty dueBy cell when dueBy is undefined (sc-4-1)", () => {
    const f = makeFinding({ id: "f-1", dueBy: undefined });
    const md = renderPriorityMd([f], "general", NOW);
    // The dueBy column cell should be empty — the row ends with "| |"
    expect(md).toMatch(/\| {0,}\|$/m);
  });

  it("emits dueBy ISO string when present (sc-4-1)", () => {
    const due = "2026-07-01T00:00:00.000Z";
    const f = makeFinding({ id: "f-1", dueBy: due });
    const md = renderPriorityMd([f], "general", NOW);
    expect(md).toContain(due);
  });

  it("escapes pipe characters in title to keep the table valid (sc-4-1)", () => {
    const f = makeFinding({ id: "f-1", title: "A|B title with | pipes" });
    const md = renderPriorityMd([f], "general", NOW);
    // Raw unescaped pipe in a cell would break the table — must be escaped
    // The cell text should contain "\\|" not a raw "|" that would split the cell
    expect(md).toContain("A\\|B");
    // The table rows should not have extra columns due to an unescaped pipe
    const tableLines = md.split("\n").filter((l) => l.startsWith("|"));
    // Each data row should have exactly 7 " | " separators (8 columns)
    for (const line of tableLines) {
      if (line.includes("rank")) continue; // skip header
      if (line.includes("---")) continue; // skip separator
      // Count unescaped pipes (not preceded by backslash)
      const rawPipes = line.match(/(?<!\\)\|/g) ?? [];
      expect(rawPipes.length).toBe(8); // 7 col separators + 2 outer = 8 total unescaped pipes
    }
  });

  it("includes a per-finding rationale/evidence section (sc-4-1)", () => {
    const f = makeFinding({
      id: "f-1",
      title: "My finding",
      evidence: ["Blood pressure elevated", "Second evidence point"],
    });
    const md = renderPriorityMd([f], "general", NOW);

    // Rationale heading
    expect(md).toContain("### 1. My finding");
    // Evidence items
    expect(md).toContain("Blood pressure elevated");
    expect(md).toContain("Second evidence point");
  });

  it("emits placeholder when evidence is empty", () => {
    const f = makeFinding({ id: "f-1", evidence: [] });
    const md = renderPriorityMd([f], "general", NOW);
    expect(md).toContain("(no evidence recorded)");
  });

  it("count: 0 when findings array is empty", () => {
    const md = renderPriorityMd([], "general", NOW);
    expect(md).toContain("count: 0");
  });

  it("uses the injected scopeLabel in frontmatter", () => {
    const md = renderPriorityMd([], "decide: exercise vs diet", NOW);
    expect(md).toContain("scope: decide: exercise vs diet");
  });
});
