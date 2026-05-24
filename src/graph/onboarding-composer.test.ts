/**
 * Colocated smoke tests for OnboardingComposer.
 *
 * Fast, dependency-free checks: module loads, render() is pure (no fs/promises),
 * and empty inputs produce empty-state messages.
 *
 * Full unit tests (snapshots, writeAll filesystem tests) live at
 * tests/graph/onboarding-composer.test.ts.
 */

import { describe, it, expect } from "vitest";
import type { OnboardingInputs } from "./types.js";

const EMPTY_INPUTS: OnboardingInputs = {
  status: { tokensaveVersion: "0.0.0", indexedFileCount: 0 },
  hotspots: [],
  deadCode: [],
  circular: [],
  largest: [],
  moduleApis: [],
  files: [],
};

describe("OnboardingComposer — colocated smoke tests", () => {
  it("can be imported and instantiated", async () => {
    const { OnboardingComposer } = await import("./onboarding-composer.js");
    const composer = new OnboardingComposer();
    expect(composer).toBeTruthy();
    expect(typeof composer.render).toBe("function");
    expect(typeof composer.writeAll).toBe("function");
  });

  it("render() does not use fs/promises (pure function guard)", async () => {
    // Read the module source and verify 'fs/promises' is not imported at the
    // module level — it is only imported at the top of the file but used
    // exclusively inside writeAll. The real guard: render() never calls any
    // Node fs function.
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const src = await readFile(
      join(import.meta.dirname ?? process.cwd(), "onboarding-composer.ts"),
      "utf-8",
    );
    // render() method body should not contain any fs calls
    const renderBodyMatch = src.match(/render\(inputs[^)]*\)[^{]*\{([\s\S]*?)^\s{2}\}/m);
    if (renderBodyMatch) {
      expect(renderBodyMatch[1]).not.toContain("readFile");
      expect(renderBodyMatch[1]).not.toContain("writeFile");
      expect(renderBodyMatch[1]).not.toContain("mkdir");
    }
  });

  it("render() with empty inputs returns all 5 empty-state messages", async () => {
    const { OnboardingComposer } = await import("./onboarding-composer.js");
    const composer = new OnboardingComposer();
    const result = composer.render(EMPTY_INPUTS);

    expect(result.architectureOverview).toContain("_No modules found._");
    expect(result.hotspots).toContain("No hotspots detected in this codebase.");
    expect(result.knowledgeGaps).toContain("No dead code detected.");
    expect(result.knowledgeGaps).toContain("All public APIs have internal callers.");
    expect(result.communities).toContain("_No communities found._");
  });

  it("render() returns an object with exactly the 5 expected keys", async () => {
    const { OnboardingComposer } = await import("./onboarding-composer.js");
    const composer = new OnboardingComposer();
    const result = composer.render(EMPTY_INPUTS);

    expect(Object.keys(result).sort()).toEqual([
      "architectureOverview",
      "communities",
      "hotspots",
      "knowledgeGaps",
      "readme",
    ]);
  });

  it("readme includes relative links to all 4 sibling files", async () => {
    const { OnboardingComposer } = await import("./onboarding-composer.js");
    const composer = new OnboardingComposer();
    const { readme } = composer.render(EMPTY_INPUTS);

    expect(readme).toContain("./architecture-overview.md");
    expect(readme).toContain("./hotspots.md");
    expect(readme).toContain("./knowledge-gaps.md");
    expect(readme).toContain("./communities.md");
  });
});
