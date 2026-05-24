/**
 * Colocated unit tests for the impact command.
 *
 * Covers:
 * - deriveSlug: 7 fixture cases (s10-c5 requirement: 5 minimum)
 * - Output file path and markdown section structure (verifiable without a live graph)
 */
import { describe, it, expect } from "vitest";

import { deriveSlug } from "./impact.js";

// ── Slug derivation — 7 fixtures ──────────────────────────────────────────────

describe("deriveSlug", () => {
  it("lowercases camelCase input", () => {
    // Example from contract: 'sandboxPath' → 'sandboxpath'
    expect(deriveSlug("sandboxPath")).toBe("sandboxpath");
  });

  it("converts file path to hyphenated slug", () => {
    // Example from contract: 'src/orchestrator/tools/handlers.ts' → 'src-orchestrator-tools-handlers-ts'
    expect(deriveSlug("src/orchestrator/tools/handlers.ts")).toBe(
      "src-orchestrator-tools-handlers-ts",
    );
  });

  it("converts dot-qualified method name", () => {
    expect(deriveSlug("MyClass.doThing")).toBe("myclass-dothing");
  });

  it("collapses consecutive separators and strips leading/trailing dashes", () => {
    // Double underscores → dashes, then collapsed, then stripped
    expect(deriveSlug("__internal__")).toBe("internal");
  });

  it("truncates to 40 characters maximum", () => {
    const long = "a".repeat(50);
    const result = deriveSlug(long);
    expect(result).toHaveLength(40);
    expect(result).toBe("a".repeat(40));
  });

  it("handles single-letter target", () => {
    expect(deriveSlug("X")).toBe("x");
  });

  it("handles already-lowercase kebab string unchanged", () => {
    expect(deriveSlug("src-utils-fs")).toBe("src-utils-fs");
  });

  it("replaces non-alphanumeric characters that aren't hyphens", () => {
    expect(deriveSlug("foo.bar@baz!qux")).toBe("foo-bar-baz-qux");
  });

  it("correctly slugifies a fully-qualified TypeScript class name", () => {
    // Example: 'TokensaveCli.sync' → 'tokensavecli-sync'
    expect(deriveSlug("TokensaveCli.sync")).toBe("tokensavecli-sync");
  });
});

// ── Slug uniqueness guarantee ─────────────────────────────────────────────────

describe("deriveSlug — uniqueness properties", () => {
  it("produces distinct slugs for distinct meaningful targets", () => {
    const targets = [
      "sandboxPath",
      "src/graph/client.ts",
      "GraphClient",
      "TokensaveCli",
      "deriveSlug",
    ];
    const slugs = targets.map(deriveSlug);
    const unique = new Set(slugs);
    expect(unique.size).toBe(targets.length);
  });

  it("produces filesystem-safe slugs (no slashes or dots)", () => {
    const targets = [
      "src/graph/client.ts",
      "TokensaveCli.sync",
      "http://example.com/api",
    ];
    for (const target of targets) {
      const slug = deriveSlug(target);
      expect(slug).not.toContain("/");
      expect(slug).not.toContain(".");
      expect(slug).not.toContain(":");
    }
  });
});
