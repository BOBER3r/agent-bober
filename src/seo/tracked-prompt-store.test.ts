/**
 * Tests for `TrackedPromptStore` (spec-20260718-in-house-ai-visibility,
 * Sprint 6, sc-6-1/sc-6-2). Real temp dirs via `mkdtemp` — no fs mocks
 * (principle L44).
 */
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { TrackedPromptStore } from "./tracked-prompt-store.js";

let dir: string;
let avDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tracked-prompts-"));
  avDir = join(dir, ".bober/seo/ai-visibility");
  await mkdir(avDir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("TrackedPromptStore.load — valid file (sc-6-1)", () => {
  it("reads a valid committed file and returns the full parsed set", async () => {
    await writeFile(
      join(avDir, "example_com.json"),
      JSON.stringify({
        target: "example.com",
        prompts: ["p1", "p2", "p3"],
        engines: ["anthropic"],
        samplesPerPrompt: 8,
        locale: "en-GB",
      }) + "\n",
      "utf-8",
    );

    const set = await new TrackedPromptStore(dir).load("example.com");

    expect(set.target).toBe("example.com");
    expect(set.prompts).toEqual(["p1", "p2", "p3"]);
    expect(set.engines).toEqual(["anthropic"]);
    expect(set.samplesPerPrompt).toBe(8);
    expect(set.locale).toBe("en-GB");
  });

  it("defaults engines/samplesPerPrompt when the file omits them", async () => {
    await writeFile(
      join(avDir, "minimal_com.json"),
      JSON.stringify({ target: "minimal.com", prompts: ["only prompt"] }) + "\n",
      "utf-8",
    );

    const set = await new TrackedPromptStore(dir).load("minimal.com");

    expect(set.prompts).toEqual(["only prompt"]);
    expect(set.engines).toEqual([]);
    expect(set.samplesPerPrompt).toBe(5);
    expect(set.locale).toBeUndefined();
  });
});

describe("TrackedPromptStore.load — fallback (sc-6-2)", () => {
  it("nonexistent target file -> byte-identical [target] fallback", async () => {
    const set = await new TrackedPromptStore(dir).load("no-such-target");

    expect(set).toEqual({
      target: "no-such-target",
      prompts: ["no-such-target"],
      engines: [],
      samplesPerPrompt: 5,
    });
  });

  it("malformed JSON -> byte-identical [target] fallback (never throws)", async () => {
    await writeFile(join(avDir, "bad_com.json"), "{ not json", "utf-8");

    const set = await new TrackedPromptStore(dir).load("bad.com");

    expect(set).toEqual({
      target: "bad.com",
      prompts: ["bad.com"],
      engines: [],
      samplesPerPrompt: 5,
    });
  });

  it("valid JSON that fails schema validation -> byte-identical [target] fallback", async () => {
    // prompts must be an array of strings; here it is a number.
    await writeFile(
      join(avDir, "wrongshape_com.json"),
      JSON.stringify({ target: "wrongshape.com", prompts: 42 }) + "\n",
      "utf-8",
    );

    const set = await new TrackedPromptStore(dir).load("wrongshape.com");

    expect(set).toEqual({
      target: "wrongshape.com",
      prompts: ["wrongshape.com"],
      engines: [],
      samplesPerPrompt: 5,
    });
  });

  it("empty directory (no .bober/seo/ai-visibility at all) -> fallback, never throws", async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), "tracked-prompts-empty-"));
    try {
      const set = await new TrackedPromptStore(emptyRoot).load("some-target");
      expect(set).toEqual({
        target: "some-target",
        prompts: ["some-target"],
        engines: [],
        samplesPerPrompt: 5,
      });
    } finally {
      await rm(emptyRoot, { recursive: true, force: true });
    }
  });
});

describe("TrackedPromptStore.load — traversal-safe filename sanitization (security)", () => {
  it("a target with path-traversal characters cannot escape the ai-visibility dir", async () => {
    // Even if an attacker-controlled target contains '../', pathFor must
    // sanitize it into a flat filename INSIDE avDir, not walk up the tree.
    const set = await new TrackedPromptStore(dir).load("../../etc/passwd");

    // No file exists at the sanitized path, so this resolves to the fallback
    // — the important assertion is that it never throws and never reads
    // outside the tracked-prompts directory.
    expect(set).toEqual({
      target: "../../etc/passwd",
      prompts: ["../../etc/passwd"],
      engines: [],
      samplesPerPrompt: 5,
    });
  });

  it("sanitized filename resolves for a target containing traversal segments", async () => {
    // '../evil' sanitizes to '___evil' — write the fixture at that exact
    // sanitized name and confirm load() finds it (proves the sanitization
    // is deterministic and consistently applied, not merely "doesn't crash").
    await writeFile(
      join(avDir, "___evil.json"),
      JSON.stringify({ target: "../evil", prompts: ["p1"] }) + "\n",
      "utf-8",
    );

    const set = await new TrackedPromptStore(dir).load("../evil");
    expect(set.prompts).toEqual(["p1"]);
  });
});
