/**
 * Unit tests for src/incident/playbook-search.ts (Sprint 25).
 *
 * Uses mkdtemp fixture directories so no actual .bober/playbooks/ files are
 * written to the repository during testing.
 *
 * Also exercises the real starter playbooks from .bober/playbooks/ to verify
 * they parse cleanly and have at least 5 steps each.
 *
 * Sprint 25 — tests/incident/playbook-search.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  loadPlaybooks,
  searchPlaybooks,
  searchPlaybooksList,
  tokenize,
  HIGH_CONFIDENCE_THRESHOLD,
  LOW_CONFIDENCE_THRESHOLD,
  type Playbook,
} from "../../src/incident/playbook-search.js";

// ── Temp directory fixture ─────────────────────────────────────────────────────

let tmpDir: string;
let playbooksDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-playbook-search-test-"));
  playbooksDir = join(tmpDir, ".bober", "playbooks");
  await mkdir(playbooksDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Minimal valid playbook template ───────────────────────────────────────────

function makePlaybookContent(
  name: string,
  classification: "standard" | "emergency",
  symptoms: string[],
): string {
  const symptomsYaml = symptoms.map((s) => `  - ${s}`).join("\n");
  return `---
name: ${name}
classification: ${classification}
applicableSymptoms:
${symptomsYaml}
prerequisites:
  - test prerequisite
---

## Step 1: First step
blastRadius: safe

precondition-check:
  - precondition for step 1

execute:
  - execute step 1

postcondition-check:
  - postcondition for step 1

## Step 2: Second step
blastRadius: safe

precondition-check:
  - precondition for step 2

execute:
  - execute step 2

postcondition-check:
  - postcondition for step 2

## Step 3: Third step
blastRadius: safe

precondition-check:
  - precondition for step 3

execute:
  - execute step 3

postcondition-check:
  - postcondition for step 3

## Step 4: Fourth step
blastRadius: risky

precondition-check:
  - precondition for step 4

execute:
  - execute step 4

postcondition-check:
  - postcondition for step 4

rollback:
  - rollback step 4

## Step 5: Fifth step
blastRadius: safe

precondition-check:
  - precondition for step 5

execute:
  - execute step 5

postcondition-check:
  - postcondition for step 5
`;
}

// ── Seed helpers ───────────────────────────────────────────────────────────────

async function seedPlaybook(
  name: string,
  classification: "standard" | "emergency",
  symptoms: string[],
): Promise<void> {
  await writeFile(
    join(playbooksDir, `${name}.md`),
    makePlaybookContent(name, classification, symptoms),
  );
}

async function seedAllStarterPlaybooks(): Promise<void> {
  // Write the four starter playbooks' content into the fixture.
  // We use simplified but valid versions that match the expected symptom keywords.
  await seedPlaybook("build-failure", "standard", [
    "ci build fails",
    "build red",
    "compilation error",
    "tests fail in ci",
    "github actions failing",
  ]);
  await seedPlaybook("migration-timeout", "emergency", [
    "database migration timing out",
    "migration hanging",
    "db migration stuck",
    "alembic timeout",
    "flyway hung",
  ]);
  await seedPlaybook("error-spike", "emergency", [
    "error rate spike",
    "5xx surge",
    "500 errors increasing",
    "error budget burning",
    "sli below objective",
  ]);
  await seedPlaybook("latency-regression", "standard", [
    "p95 latency increase",
    "p99 latency spike",
    "response time degradation",
    "slow responses",
    "latency regression",
  ]);
}

// ── tokenize unit tests ───────────────────────────────────────────────────────

describe("tokenize", () => {
  it("lowercases and splits on whitespace", () => {
    expect(tokenize("Error Rate Spike")).toEqual(["error", "rate", "spike"]);
  });

  it("removes stopwords", () => {
    const tokens = tokenize("the database is timing out");
    expect(tokens).not.toContain("the");
    expect(tokens).not.toContain("is");
    expect(tokens).toContain("database");
    expect(tokens).toContain("timing");
    expect(tokens).toContain("out");
  });

  it("splits on common punctuation", () => {
    const tokens = tokenize("p95-latency/spike: now!");
    expect(tokens).toContain("p95");
    expect(tokens).toContain("latency");
    expect(tokens).toContain("spike");
    expect(tokens).toContain("now");
  });

  it("drops empty tokens", () => {
    const tokens = tokenize("  hello   world  ");
    expect(tokens).toEqual(["hello", "world"]);
  });
});

// ── loadPlaybooks ─────────────────────────────────────────────────────────────

describe("loadPlaybooks", () => {
  it("returns [] when .bober/playbooks/ directory does not exist", async () => {
    // Use a fresh temp dir with no .bober/ subdir.
    const emptyDir = await mkdtemp(join(tmpdir(), "bober-empty-"));
    try {
      const result = await loadPlaybooks(emptyDir);
      expect(result).toEqual([]);
    } finally {
      await rm(emptyDir, { recursive: true, force: true });
    }
  });

  it("returns [] when directory is empty", async () => {
    const result = await loadPlaybooks(tmpDir);
    expect(result).toEqual([]);
  });

  it("skips README.md", async () => {
    await writeFile(
      join(playbooksDir, "README.md"),
      "# This is the README — not a playbook\n",
    );
    await seedPlaybook("my-playbook", "standard", ["some symptom"]);
    const result = await loadPlaybooks(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("my-playbook");
  });

  it("skips files with missing frontmatter", async () => {
    await writeFile(
      join(playbooksDir, "no-frontmatter.md"),
      "# Just markdown, no frontmatter\n\nSome content here.\n",
    );
    await seedPlaybook("valid", "standard", ["valid symptom"]);
    const result = await loadPlaybooks(tmpDir);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("valid");
  });

  it("skips files with incomplete frontmatter (missing applicableSymptoms)", async () => {
    await writeFile(
      join(playbooksDir, "incomplete.md"),
      `---\nname: incomplete\nclassification: standard\n---\n\n## Step 1: test\nblastRadius: safe\n`,
    );
    await seedPlaybook("valid", "standard", ["valid symptom"]);
    const result = await loadPlaybooks(tmpDir);
    expect(result).toHaveLength(1);
  });

  it("reads all 4 starter playbooks from the fixture", async () => {
    await seedAllStarterPlaybooks();
    const result = await loadPlaybooks(tmpDir);
    expect(result).toHaveLength(4);
    const names = result.map((p) => p.name).sort();
    expect(names).toEqual([
      "build-failure",
      "error-spike",
      "latency-regression",
      "migration-timeout",
    ]);
  });

  it("each loaded playbook has correct classification", async () => {
    await seedAllStarterPlaybooks();
    const result = await loadPlaybooks(tmpDir);
    const byName = Object.fromEntries(result.map((p) => [p.name, p]));
    expect(byName["build-failure"]?.classification).toBe("standard");
    expect(byName["migration-timeout"]?.classification).toBe("emergency");
    expect(byName["error-spike"]?.classification).toBe("emergency");
    expect(byName["latency-regression"]?.classification).toBe("standard");
  });

  it("each loaded playbook has applicableSymptoms list", async () => {
    await seedAllStarterPlaybooks();
    const result = await loadPlaybooks(tmpDir);
    for (const pb of result) {
      expect(pb.applicableSymptoms.length).toBeGreaterThan(0);
    }
  });

  it("loaded playbooks have filePath set", async () => {
    await seedPlaybook("test-pb", "standard", ["a symptom"]);
    const result = await loadPlaybooks(tmpDir);
    expect(result[0]?.filePath).toContain("test-pb.md");
  });
});

// ── searchPlaybooks ───────────────────────────────────────────────────────────

describe("searchPlaybooks", () => {
  it("returns sorted descending by confidence", async () => {
    await seedPlaybook("high-match", "standard", ["database migration timing out"]);
    await seedPlaybook("low-match", "standard", ["database connection error"]);
    const matches = await searchPlaybooks("database migration is timing out", tmpDir);
    expect(matches.length).toBeGreaterThan(0);
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1]!.confidence).toBeGreaterThanOrEqual(
        matches[i]!.confidence,
      );
    }
  });

  it("returns zero results for empty symptom", async () => {
    await seedAllStarterPlaybooks();
    const matches = await searchPlaybooks("", tmpDir);
    expect(matches).toHaveLength(0);
  });

  it("database migration is timing out → migration-timeout HIGH confidence (≥0.6)", async () => {
    await seedAllStarterPlaybooks();
    const matches = await searchPlaybooks("database migration is timing out", tmpDir);
    const mtMatch = matches.find((m) => m.playbook.name === "migration-timeout");
    expect(mtMatch).toBeDefined();
    expect(mtMatch!.confidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE_THRESHOLD);
  });

  it("p99 latency spike → latency-regression HIGH confidence (≥0.6)", async () => {
    await seedAllStarterPlaybooks();
    const matches = await searchPlaybooks("p99 latency spike", tmpDir);
    const lrMatch = matches.find((m) => m.playbook.name === "latency-regression");
    expect(lrMatch).toBeDefined();
    expect(lrMatch!.confidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE_THRESHOLD);
  });

  it("user reports button is grey → NO high-confidence matches (< 0.6)", async () => {
    await seedAllStarterPlaybooks();
    const matches = await searchPlaybooks("user reports button is grey", tmpDir);
    const highConf = matches.filter((m) => m.confidence >= HIGH_CONFIDENCE_THRESHOLD);
    expect(highConf).toHaveLength(0);
  });

  it("ci build fails → build-failure HIGH confidence (≥0.6)", async () => {
    await seedAllStarterPlaybooks();
    const matches = await searchPlaybooks("build is failing in ci", tmpDir);
    const bfMatch = matches.find((m) => m.playbook.name === "build-failure");
    expect(bfMatch).toBeDefined();
    expect(bfMatch!.confidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE_THRESHOLD);
  });

  it("error rate spike → error-spike HIGH confidence (≥0.6)", async () => {
    await seedAllStarterPlaybooks();
    const matches = await searchPlaybooks("error rate spike", tmpDir);
    const esMatch = matches.find((m) => m.playbook.name === "error-spike");
    expect(esMatch).toBeDefined();
    expect(esMatch!.confidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE_THRESHOLD);
  });

  it("includes matchedTokens for transparency", async () => {
    await seedPlaybook("test-pb", "standard", ["migration timing out"]);
    const matches = await searchPlaybooks("migration is timing out", tmpDir);
    expect(matches.length).toBeGreaterThan(0);
    const m = matches[0]!;
    expect(m.matchedTokens.length).toBeGreaterThan(0);
    // Should include 'migration', 'timing', 'out' (stopword 'is' dropped)
    expect(m.matchedTokens).toContain("migration");
    expect(m.matchedTokens).toContain("timing");
    expect(m.matchedTokens).toContain("out");
  });

  it("confidence is clamped to [0, 1]", async () => {
    await seedAllStarterPlaybooks();
    const matches = await searchPlaybooks("error rate spike sli below objective", tmpDir);
    for (const m of matches) {
      expect(m.confidence).toBeGreaterThanOrEqual(0);
      expect(m.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("no match for completely unrelated query returns empty or only low-confidence", async () => {
    await seedAllStarterPlaybooks();
    const matches = await searchPlaybooks("quarterly revenue forecast chart", tmpDir);
    const highConf = matches.filter((m) => m.confidence >= HIGH_CONFIDENCE_THRESHOLD);
    expect(highConf).toHaveLength(0);
  });
});

// ── searchPlaybooksList (in-memory, no disk) ──────────────────────────────────

describe("searchPlaybooksList", () => {
  const makePlaybook = (
    name: string,
    symptoms: string[],
    classification: "standard" | "emergency" = "standard",
  ): Playbook => ({
    name,
    classification,
    applicableSymptoms: symptoms,
    prerequisites: [],
    filePath: `/fake/${name}.md`,
    stepSections: [],
  });

  it("exact phrase match → confidence = 1.0", () => {
    const playbooks = [makePlaybook("exact", ["migration hanging"])];
    const matches = searchPlaybooksList("migration hanging", playbooks);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.confidence).toBe(1.0);
  });

  it("partial match → confidence = overlap / phrase_length", () => {
    // phrase = "database migration timing out" → 4 tokens after stopword removal
    // query = "migration timing" → 2 tokens
    // overlap = 2, phrase_length = 4, score = 0.5
    const playbooks = [makePlaybook("partial", ["database migration timing out"])];
    const matches = searchPlaybooksList("migration timing", playbooks);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.confidence).toBeCloseTo(0.5);
  });

  it("takes max score across multiple phrases", () => {
    const playbooks = [
      makePlaybook("multi", [
        "some unrelated phrase about nothing",
        "migration hanging now",
      ]),
    ];
    // "migration hanging" overlaps 2/3 with "migration hanging now"
    const matches = searchPlaybooksList("migration hanging", playbooks);
    expect(matches).toHaveLength(1);
    // 2 overlapping tokens out of 3 phrase tokens = 0.667
    expect(matches[0]!.confidence).toBeCloseTo(2 / 3);
  });

  it("returns results sorted descending", () => {
    // "migration timing out" → 3 tokens; query "migration timing" overlaps 2/3 = 0.667
    // "latency spike regression" → 3 tokens; query "migration timing" overlaps 0/3 = 0
    const playbooks = [
      makePlaybook("no-match", ["latency spike regression"]),
      makePlaybook("partial-match", ["migration timing out"]),
    ];
    const matches = searchPlaybooksList("migration timing", playbooks);
    // Only partial-match should appear (no-match has 0 score, not returned)
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0]!.playbook.name).toBe("partial-match");
    expect(matches[0]!.confidence).toBeGreaterThan(0);
    // If both return results, first should have >= confidence
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1]!.confidence).toBeGreaterThanOrEqual(matches[i]!.confidence);
    }
  });

  it("returns empty array when no tokens match", () => {
    const playbooks = [makePlaybook("noop", ["latency regression"])];
    const matches = searchPlaybooksList("button clicked", playbooks);
    expect(matches).toHaveLength(0);
  });
});

// ── Starter playbook parse validity ──────────────────────────────────────────

describe("starter playbooks — parse validity", () => {
  // These tests load from the ACTUAL .bober/playbooks/ in the repository.
  // They verify the real files parse cleanly and have ≥5 steps.

  const repoRoot = resolve(join(import.meta.url.replace("file://", ""), "../../.."));

  it("build-failure.md parses cleanly and has ≥5 steps", async () => {
    const playbooks = await loadPlaybooks(repoRoot);
    const pb = playbooks.find((p) => p.name === "build-failure");
    expect(pb).toBeDefined();
    expect(pb!.applicableSymptoms.length).toBeGreaterThanOrEqual(4);
    expect(pb!.stepSections.length).toBeGreaterThanOrEqual(5);
  });

  it("migration-timeout.md parses cleanly and has ≥5 steps", async () => {
    const playbooks = await loadPlaybooks(repoRoot);
    const pb = playbooks.find((p) => p.name === "migration-timeout");
    expect(pb).toBeDefined();
    expect(pb!.applicableSymptoms.length).toBeGreaterThanOrEqual(4);
    expect(pb!.stepSections.length).toBeGreaterThanOrEqual(5);
  });

  it("error-spike.md parses cleanly and has ≥5 steps", async () => {
    const playbooks = await loadPlaybooks(repoRoot);
    const pb = playbooks.find((p) => p.name === "error-spike");
    expect(pb).toBeDefined();
    expect(pb!.applicableSymptoms.length).toBeGreaterThanOrEqual(4);
    expect(pb!.stepSections.length).toBeGreaterThanOrEqual(5);
  });

  it("latency-regression.md parses cleanly and has ≥5 steps", async () => {
    const playbooks = await loadPlaybooks(repoRoot);
    const pb = playbooks.find((p) => p.name === "latency-regression");
    expect(pb).toBeDefined();
    expect(pb!.applicableSymptoms.length).toBeGreaterThanOrEqual(4);
    expect(pb!.stepSections.length).toBeGreaterThanOrEqual(5);
  });

  it("all 4 starter playbooks present in repo", async () => {
    const playbooks = await loadPlaybooks(repoRoot);
    const names = playbooks.map((p) => p.name);
    expect(names).toContain("build-failure");
    expect(names).toContain("migration-timeout");
    expect(names).toContain("error-spike");
    expect(names).toContain("latency-regression");
  });

  it("starter playbooks high-confidence for real-repo search: db migration timing out", async () => {
    const matches = await searchPlaybooks("database migration is timing out", repoRoot);
    const mtMatch = matches.find((m) => m.playbook.name === "migration-timeout");
    expect(mtMatch).toBeDefined();
    expect(mtMatch!.confidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE_THRESHOLD);
  });

  it("starter playbooks high-confidence for real-repo search: p99 latency spike", async () => {
    const matches = await searchPlaybooks("p99 latency spike", repoRoot);
    const lrMatch = matches.find((m) => m.playbook.name === "latency-regression");
    expect(lrMatch).toBeDefined();
    expect(lrMatch!.confidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE_THRESHOLD);
  });
});

// ── Confidence threshold constants ────────────────────────────────────────────

describe("confidence threshold constants", () => {
  it("HIGH_CONFIDENCE_THRESHOLD is 0.6", () => {
    expect(HIGH_CONFIDENCE_THRESHOLD).toBe(0.6);
  });

  it("LOW_CONFIDENCE_THRESHOLD is 0.3", () => {
    expect(LOW_CONFIDENCE_THRESHOLD).toBe(0.3);
  });

  it("HIGH > LOW", () => {
    expect(HIGH_CONFIDENCE_THRESHOLD).toBeGreaterThan(LOW_CONFIDENCE_THRESHOLD);
  });
});
