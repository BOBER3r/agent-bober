import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { SeoPlaybookParser } from "./parser.js";

// ── Real-asset test: parses the actual generic skill file (sc-2-2) ────

describe("SeoPlaybookParser — real generic skill file", () => {
  it("parses skills/bober.seo-generic/SKILL.md into >=10 valid signatures", async () => {
    const md = await readFile(new URL("../../skills/bober.seo-generic/SKILL.md", import.meta.url), "utf-8");

    const signatures = SeoPlaybookParser.parse(md, "skills/bober.seo-generic/SKILL.md");

    expect(signatures.length).toBeGreaterThanOrEqual(10);

    for (const signature of signatures) {
      expect(signature.playbookId.length).toBeGreaterThan(0);
      expect(signature.title.length).toBeGreaterThan(0);
      expect(signature.primarySourceUrl.trim()).not.toBe("");
      expect(["auto-safe", "human-approve"]).toContain(signature.policyClass);
      expect(["verified", "primary-unverified", "single-source"]).toContain(signature.evidenceGrade);
      expect(signature.skillRef).toBe("skills/bober.seo-generic/SKILL.md");
    }
  });

  it("drops the never-encode boundary block (parasite-seo-placement) from the real file", async () => {
    const md = await readFile(new URL("../../skills/bober.seo-generic/SKILL.md", import.meta.url), "utf-8");
    const signatures = SeoPlaybookParser.parse(md, "skills/bober.seo-generic/SKILL.md");
    const ids = signatures.map((s) => s.playbookId);
    expect(ids).not.toContain("parasite-seo-placement");
  });

  it("covers every playbookId unique (no duplicate ids in the real file)", async () => {
    const md = await readFile(new URL("../../skills/bober.seo-generic/SKILL.md", import.meta.url), "utf-8");
    const signatures = SeoPlaybookParser.parse(md, "x");
    const ids = signatures.map((s) => s.playbookId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reports a dropped-block count of exactly 1 for the real file (the never-encode boundary block)", async () => {
    const md = await readFile(new URL("../../skills/bober.seo-generic/SKILL.md", import.meta.url), "utf-8");
    const { signatures, dropped } = SeoPlaybookParser.parseWithDiagnostics(
      md,
      "skills/bober.seo-generic/SKILL.md",
    );
    expect(dropped).toBe(1);
    expect(signatures.length).toBeGreaterThanOrEqual(10);
  });
});

// ── Totality: parser never throws, drops malformed/uncited/never-encode ──

describe("SeoPlaybookParser — total, pure", () => {
  it("never throws on malformed input", () => {
    const malformedInputs = [
      "",
      "not markdown",
      "### \n(no fields)",
      "### missing-url\n- **Title:** t\n- **PolicyClass:** auto-safe",
      "### never\n- **Title:** t\n- **PrimarySourceUrl:** https://x\n- **PolicyClass:** never-encode",
      "### trunc\n- **Title:** t\n**Tactic:**\n```\nno closing fence",
      "### bad-policy\n- **Title:** t\n- **PrimarySourceUrl:** https://x\n- **PolicyClass:** sometimes",
      "### no-signature-id\n\n\n- **Title:** t\n- **PrimarySourceUrl:** https://x\n- **PolicyClass:** auto-safe",
    ];

    for (const input of malformedInputs) {
      expect(() => SeoPlaybookParser.parse(input, "x")).not.toThrow();
      expect(() => SeoPlaybookParser.parseWithDiagnostics(input, "x")).not.toThrow();
    }
  });

  it("returns [] for an empty file", () => {
    expect(SeoPlaybookParser.parse("", "x")).toEqual([]);
  });

  it("returns [] for non-string input without throwing", () => {
    // @ts-expect-error deliberately passing a non-string to exercise the type guard
    expect(SeoPlaybookParser.parse(null, "x")).toEqual([]);
    // @ts-expect-error deliberately passing a non-string to exercise the type guard
    expect(SeoPlaybookParser.parse(undefined, "x")).toEqual([]);
  });

  it("drops uncited + never-encode blocks, keeps the cited auto-safe/human-approve block", () => {
    const md = [
      "### uncited",
      "- **Title:** no url",
      "- **PolicyClass:** auto-safe",
      "",
      "### parasite",
      "- **Title:** banned",
      "- **PrimarySourceUrl:** https://x",
      "- **PolicyClass:** never-encode",
      "",
      "### good-one",
      "- **Title:** Good",
      "- **Workflows:** ai-visibility",
      "- **Tactic:** do X",
      "- **Invariant:** because Y",
      "- **PrimarySourceUrl:** https://ahrefs.com/blog/ai-brand-visibility-correlations/",
      "- **PolicyClass:** auto-safe",
      "- **EvidenceGrade:** verified",
      "- **Keywords:** geo",
    ].join("\n");

    const sigs = SeoPlaybookParser.parse(md, "x");
    expect(sigs).toHaveLength(1);
    expect(sigs[0].playbookId).toBe("good-one");
    expect(["auto-safe", "human-approve"]).toContain(sigs[0].policyClass);
    expect(sigs[0].workflows).toEqual(["ai-visibility"]);
  });

  it("reports the dropped count alongside the surviving signatures", () => {
    const md = [
      "### uncited",
      "- **Title:** no url",
      "- **PolicyClass:** auto-safe",
      "",
      "### parasite",
      "- **Title:** banned",
      "- **PrimarySourceUrl:** https://x",
      "- **PolicyClass:** never-encode",
      "",
      "### good-one",
      "- **Title:** Good",
      "- **PrimarySourceUrl:** https://x",
      "- **PolicyClass:** auto-safe",
    ].join("\n");

    const { signatures, dropped } = SeoPlaybookParser.parseWithDiagnostics(md, "x");
    expect(signatures).toHaveLength(1);
    expect(dropped).toBe(2);
  });

  it("filters invalid Workflows members but keeps the block (soft field)", () => {
    const md = [
      "### mixed-workflows",
      "- **Title:** t",
      "- **Workflows:** ai-visibility, not-a-real-workflow, schema-audit",
      "- **PrimarySourceUrl:** https://x",
      "- **PolicyClass:** auto-safe",
    ].join("\n");

    const sigs = SeoPlaybookParser.parse(md, "x");
    expect(sigs).toHaveLength(1);
    expect(sigs[0].workflows).toEqual(["ai-visibility", "schema-audit"]);
  });

  it("defaults EvidenceGrade to single-source when absent or invalid (soft field)", () => {
    const md = [
      "### absent-grade",
      "- **Title:** t",
      "- **PrimarySourceUrl:** https://x",
      "- **PolicyClass:** auto-safe",
      "",
      "### invalid-grade",
      "- **Title:** t2",
      "- **PrimarySourceUrl:** https://x",
      "- **PolicyClass:** auto-safe",
      "- **EvidenceGrade:** bogus",
    ].join("\n");

    const sigs = SeoPlaybookParser.parse(md, "x");
    expect(sigs).toHaveLength(2);
    for (const s of sigs) expect(s.evidenceGrade).toBe("single-source");
  });

  // sc-3-1 (spec-20260717-seo-improver-builder): LiveWeightStatus is a soft
  // field mirroring EvidenceGrade exactly -- absent or garbage defaults to
  // "unknown", never throws; a valid value round-trips.
  it("defaults liveWeightStatus to unknown when absent or invalid (soft field)", () => {
    const md = [
      "### absent-live-weight",
      "- **Title:** t",
      "- **PrimarySourceUrl:** https://x",
      "- **PolicyClass:** auto-safe",
      "",
      "### invalid-live-weight",
      "- **Title:** t2",
      "- **PrimarySourceUrl:** https://x",
      "- **PolicyClass:** auto-safe",
      "- **LiveWeightStatus:** bogus-garbage-value",
    ].join("\n");

    const sigs = SeoPlaybookParser.parse(md, "x");
    expect(sigs).toHaveLength(2);
    for (const s of sigs) expect(s.liveWeightStatus).toBe("unknown");
  });

  it("round-trips a valid liveWeightStatus value (documented-only, live-corroborated)", () => {
    const md = [
      "### documented-only-sig",
      "- **Title:** t",
      "- **PrimarySourceUrl:** https://x",
      "- **PolicyClass:** auto-safe",
      "- **LiveWeightStatus:** documented-only",
      "",
      "### live-corroborated-sig",
      "- **Title:** t2",
      "- **PrimarySourceUrl:** https://x",
      "- **PolicyClass:** auto-safe",
      "- **LiveWeightStatus:** live-corroborated",
    ].join("\n");

    const sigs = SeoPlaybookParser.parse(md, "x");
    expect(sigs).toHaveLength(2);
    expect(sigs.find((s) => s.playbookId === "documented-only-sig")?.liveWeightStatus).toBe("documented-only");
    expect(sigs.find((s) => s.playbookId === "live-corroborated-sig")?.liveWeightStatus).toBe("live-corroborated");
  });

  it("never throws on a malformed LiveWeightStatus label value", () => {
    const malformedInputs = [
      "### garbage-live-weight\n- **Title:** t\n- **PrimarySourceUrl:** https://x\n- **PolicyClass:** auto-safe\n- **LiveWeightStatus:** \n",
      "### numeric-live-weight\n- **Title:** t\n- **PrimarySourceUrl:** https://x\n- **PolicyClass:** auto-safe\n- **LiveWeightStatus:** 12345",
    ];
    for (const input of malformedInputs) {
      expect(() => SeoPlaybookParser.parse(input, "x")).not.toThrow();
    }
  });

  it("defaults Tactic/Invariant/Keywords to empty when absent (soft fields)", () => {
    const md = ["### minimal", "- **Title:** t", "- **PrimarySourceUrl:** https://x", "- **PolicyClass:** auto-safe"].join(
      "\n",
    );
    const sigs = SeoPlaybookParser.parse(md, "x");
    expect(sigs).toHaveLength(1);
    expect(sigs[0].tactic).toBe("");
    expect(sigs[0].invariant).toBe("");
    expect(sigs[0].keywords).toEqual([]);
  });

  it("is pure — does not mutate its inputs", () => {
    const md =
      "### sig\n- **Title:** t\n- **PrimarySourceUrl:** https://x\n- **PolicyClass:** auto-safe\n- **Keywords:** a, b";
    const snapshot = md;
    SeoPlaybookParser.parse(md, "x");
    expect(md).toBe(snapshot);
  });
});
