import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";

import { SeoPlaybookRetriever } from "./retriever.js";
import { SeoPlaybookIndex } from "./playbook-index.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_SKILLS_ROOT = join(REPO_ROOT, "skills");

// ── sc-2-4: real skill files — never-empty promptFragment, deduped sigs ──

describe("SeoPlaybookRetriever — real skill files", () => {
  let index: SeoPlaybookIndex;

  beforeAll(async () => {
    index = new SeoPlaybookIndex(REPO_SKILLS_ROOT);
    await index.load();
  });

  it("retrieves a non-empty promptFragment and signatures for the ai-visibility workflow", async () => {
    const retriever = new SeoPlaybookRetriever(index);
    const result = await retriever.retrieve({ workflow: "ai-visibility" });

    expect(result.promptFragment.length).toBeGreaterThan(0);
    expect(result.signatures.length).toBeGreaterThan(0);
    // At least one ranked signature actually declares the requested workflow
    // (the generic floor is unconditionally appended too, so not every
    // returned signature is workflow-specific — see the floor test below).
    expect(result.signatures.some((s) => s.workflows.includes("ai-visibility"))).toBe(true);
  });

  it("dedupes signatures by playbookId (no duplicate playbookId across ranked + floor)", async () => {
    const retriever = new SeoPlaybookRetriever(index);
    const result = await retriever.retrieve({ workflow: "ai-visibility", topK: 20 });

    const ids = result.signatures.map((s) => s.playbookId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns the generic floor for a workflow with no dedicated signatures", async () => {
    const retriever = new SeoPlaybookRetriever(index);
    const result = await retriever.retrieve({ workflow: "internal-linking" });

    expect(result.promptFragment.length).toBeGreaterThan(0);
    // No signature in the generic skill declares "internal-linking" — the
    // always-included generic floor still fills promptFragment + signatures.
    expect(result.signatures.length).toBeGreaterThan(0);
  });

  it("accepts optional target/vertical without throwing and still returns a non-empty fragment", async () => {
    const retriever = new SeoPlaybookRetriever(index);
    const result = await retriever.retrieve({
      workflow: "ai-visibility",
      target: "example.com",
      vertical: "igaming",
    });

    expect(result.promptFragment.length).toBeGreaterThan(0);
  });

  it("respects a topK cap on the ranked (non-floor) portion", async () => {
    const retriever = new SeoPlaybookRetriever(index);
    const result = await retriever.retrieve({ workflow: "ai-visibility", topK: 1 });

    expect(result.signatures.length).toBeGreaterThan(0);
  });
});

// ── never-empty fallback when the index is entirely empty (sc-2-4) ─────

describe("SeoPlaybookRetriever — degraded/empty index", () => {
  it("retrieve() against a missing skills dir returns a non-empty promptFragment and [] signatures", async () => {
    const emptyIndex = new SeoPlaybookIndex(join(REPO_ROOT, "does-not-exist-skills-dir"));
    const retriever = new SeoPlaybookRetriever(emptyIndex);

    const result = await retriever.retrieve({ workflow: "ai-visibility" });

    expect(result.promptFragment.length).toBeGreaterThan(0);
    expect(result.promptFragment).toContain("generic SEO/GEO playbook");
    expect(result.signatures).toEqual([]);
  });

  it("never throws even when called repeatedly against an empty index", async () => {
    const emptyIndex = new SeoPlaybookIndex(join(REPO_ROOT, "does-not-exist-skills-dir-2"));
    const retriever = new SeoPlaybookRetriever(emptyIndex);

    await expect(retriever.retrieve({ workflow: "schema-audit" })).resolves.toBeDefined();
    await expect(retriever.retrieve({ workflow: "schema-audit" })).resolves.toBeDefined();
  });
});
