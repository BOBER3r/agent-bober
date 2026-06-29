/**
 * Tests for src/research/digest.ts (sc-5-1 / sc-5-2 / sc-5-3).
 *
 * Injects a fake collectRuns — no real vault notes needed.
 * Writes to a real temp dir — no fs mocks (principles L44).
 */

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { buildDigest, renderDigestMarkdown } from "./digest.js";
import type { Digest, DigestRun } from "./digest.js";

// ── Fixtures ──────────────────────────────────────────────────────────

const NOW = "2026-06-28T12:00:00.000Z";
const SINCE = "2026-06-27T12:00:00.000Z";

const TWO_RUNS: DigestRun[] = [
  {
    title: "Research — A",
    topFinding: "finding A",
    generatedAt: NOW,
    source: "/v/research/2026-06-28-a.md",
  },
  {
    title: "Research — B",
    topFinding: "finding B",
    generatedAt: NOW,
    source: "/v/research/2026-06-28-b.md",
  },
];

// ── Temp dir lifecycle ────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-research-digest-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ── renderDigestMarkdown (pure) ───────────────────────────────────────

describe("renderDigestMarkdown", () => {
  it("renders two runs with titles and top findings", () => {
    const digest: Digest = { since: SINCE, now: NOW, generatedAt: NOW, runs: TWO_RUNS };
    const md = renderDigestMarkdown(digest);
    expect(md).toContain("Research — A");
    expect(md).toContain("Research — B");
    expect(md).toContain("finding A");
    expect(md).toContain("finding B");
  });

  it("empty window: contains explicit no-new-research statement", () => {
    const digest: Digest = { since: SINCE, now: NOW, generatedAt: NOW, runs: [] };
    const md = renderDigestMarkdown(digest);
    expect(md.toLowerCase()).toContain("no new research");
  });

  it("includes the window timestamps in the output", () => {
    const digest: Digest = { since: SINCE, now: NOW, generatedAt: NOW, runs: [] };
    const md = renderDigestMarkdown(digest);
    expect(md).toContain(SINCE);
    expect(md).toContain(NOW);
  });
});

// ── buildDigest ───────────────────────────────────────────────────────

describe("buildDigest", () => {
  it("sc-5-1/sc-5-2: md lists both titles + top findings; json has 2-element runs array", async () => {
    const digestsDir = join(tmpRoot, ".bober", "research", "digests");
    const res = await buildDigest(SINCE, NOW, {
      collectRuns: async () => TWO_RUNS,
      digestsDir,
    });

    // Markdown assertions
    const md = await readFile(res.mdPath, "utf-8");
    expect(md).toContain("Research — A");
    expect(md).toContain("Research — B");
    expect(md).toContain("finding A");
    expect(md).toContain("finding B");

    // JSON assertions
    const json = JSON.parse(await readFile(res.jsonPath, "utf-8")) as {
      since: string;
      now: string;
      generatedAt: string;
      runs: DigestRun[];
    };
    expect(json.runs).toHaveLength(2);

    // File names: date = now.slice(0, 10) = "2026-06-28"
    expect(res.mdPath.endsWith("2026-06-28.md")).toBe(true);
    expect(res.jsonPath.endsWith("2026-06-28.json")).toBe(true);
  });

  it("sc-5-3: empty window -> no-new-research body + both files written", async () => {
    const digestsDir = join(tmpRoot, ".bober", "research", "digests");
    const res = await buildDigest(SINCE, NOW, {
      collectRuns: async () => [],
      digestsDir,
    });

    // Markdown must explicitly state no new research
    const md = await readFile(res.mdPath, "utf-8");
    expect(md.toLowerCase()).toContain("no new research");

    // JSON must have empty runs array (not missing)
    const json = JSON.parse(await readFile(res.jsonPath, "utf-8")) as {
      runs: unknown[];
    };
    expect(json.runs).toEqual([]);

    // Both files exist (readFile above would throw if missing)
    expect(res.mdPath.endsWith("2026-06-28.md")).toBe(true);
    expect(res.jsonPath.endsWith("2026-06-28.json")).toBe(true);
  });

  it("digest JSON has the stable Telegram-consumer shape (since, now, generatedAt, runs)", async () => {
    const digestsDir = join(tmpRoot, ".bober", "research", "digests");
    const res = await buildDigest(SINCE, NOW, {
      collectRuns: async () => TWO_RUNS,
      digestsDir,
    });

    const json = JSON.parse(await readFile(res.jsonPath, "utf-8")) as {
      since: string;
      now: string;
      generatedAt: string;
      runs: DigestRun[];
    };
    expect(json.since).toBe(SINCE);
    expect(json.now).toBe(NOW);
    expect(json.generatedAt).toBe(NOW);
    expect(json.runs).toHaveLength(2);
    expect(json.runs[0]!.title).toBe("Research — A");
    expect(json.runs[1]!.topFinding).toBe("finding B");
  });

  it("creates digestsDir if it does not exist (ensureDir path)", async () => {
    // Use a nested path that certainly doesn't exist yet
    const digestsDir = join(tmpRoot, "deeply", "nested", "digests");
    const res = await buildDigest(SINCE, NOW, {
      collectRuns: async () => [],
      digestsDir,
    });
    // Both files written means the dir was created
    const md = await readFile(res.mdPath, "utf-8");
    expect(md.length).toBeGreaterThan(0);
  });

  it("JSON file ends with a trailing newline (mirrors fleet/index.ts:69)", async () => {
    const digestsDir = join(tmpRoot, ".bober", "research", "digests");
    const res = await buildDigest(SINCE, NOW, {
      collectRuns: async () => TWO_RUNS,
      digestsDir,
    });
    const raw = await readFile(res.jsonPath, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
  });
});
