import { describe, it, expect, beforeAll } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { LocalExportSource, parseCsv } from "./local-export.js";

const IMPORTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "__fixtures__", "imports");

// ── LocalExportSource — offline data arms (sc-6-2..6-4) ─────────────────

describe("LocalExportSource — offline data arms (sc-6-2..6-4)", () => {
  let src: LocalExportSource;

  beforeAll(async () => {
    src = new LocalExportSource(IMPORTS_DIR);
    await src.load();
  });

  it("present populated file => data + typed rows + provenance{path,mtimeMs} (sc-6-1, sc-6-4)", async () => {
    const out = await src.searchAnalytics({
      siteUrl: "https://example.com",
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      dimensions: ["query"],
    });

    expect(out.kind).toBe("data");
    if (out.kind !== "data") return;
    expect(out.rows.length).toBe(3);

    // Typed numeric coercion (row 1 of the fixture).
    expect(out.rows[0]).toEqual({
      query: "best online casino",
      page: "/reviews/best-online-casino",
      country: "Berlin, DE", // proves the quoted-comma field stayed ONE column
      device: "mobile",
      clicks: 142,
      impressions: 3800,
      ctr: 0.0374,
      position: 4.2,
    });

    // Provenance (sc-6-4).
    expect(out.provenance.source).toBe("local-export");
    expect(typeof out.provenance.retrievedAt).toBe("string");
    expect(out.provenance.path?.endsWith("search-analytics.csv")).toBe(true);
    expect(typeof out.provenance.mtimeMs).toBe("number");
    expect(out.provenance.mtimeMs).toBeGreaterThan(0);
  });

  it("present populated ai-visibility.csv => data + typed rows + provenance (sc-5-3)", async () => {
    const out = await src.aiVisibility({ target: "https://target.example", prompts: ["best crypto casino", "top no-kyc exchange"] });

    expect(out.kind).toBe("data");
    if (out.kind !== "data") return;
    expect(out.rows).toEqual([
      {
        prompt: "best crypto casino",
        provider: "perplexity",
        mentioned: true,
        rank: 2,
        citationPresent: true,
        sourceUrls: ["https://target.example/a", "https://target.example/b"],
      },
      {
        // Empty sourceUrls / missing rank coerce to [] / undefined (sc-5-3).
        prompt: "top no-kyc exchange",
        provider: "perplexity",
        mentioned: false,
        rank: undefined,
        citationPresent: false,
        sourceUrls: [],
      },
    ]);
    expect(out.provenance.source).toBe("local-export");
    expect(out.provenance.path?.endsWith("ai-visibility.csv")).toBe(true);
  });

  it("absent ai-visibility file => disabled (sc-5-3)", async () => {
    const missing = new LocalExportSource(join(IMPORTS_DIR, "does-not-exist-dir"));
    await missing.load();
    const out = await missing.aiVisibility({ target: "https://target.example", prompts: ["x"] });
    expect(out).toEqual({ kind: "disabled" });
  });

  it("absent-file capability => disabled, never throws (sc-6-3)", async () => {
    const out = await src.backlinks({ target: "https://example.com" });
    expect(out).toEqual({ kind: "disabled" });
  });

  it("absent-file capability (keywords, url-inspection) => disabled (sc-6-3)", async () => {
    await expect(src.keywords({ keywords: ["x"], location: "us" })).resolves.toEqual({
      kind: "disabled",
    });
    await expect(
      src.urlInspection({ siteUrl: "https://example.com", inspectionUrl: "https://example.com/x" }),
    ).resolves.toEqual({ kind: "disabled" });
  });

  it("header-only file => abstain with a reason, never throws (sc-6-3)", async () => {
    const out = await src.serp({ keyword: "best casino", location: "us" });
    expect(out.kind).toBe("abstain");
    if (out.kind !== "abstain") return;
    expect(typeof out.reason).toBe("string");
    expect(out.reason.length).toBeGreaterThan(0);
  });

  it("capabilities() advertises only present files (sc-6-2)", () => {
    const caps = src.capabilities();
    expect(caps).toContain("search-analytics");
    expect(caps).toContain("serp");
    expect(caps).not.toContain("backlinks");
    expect(caps).not.toContain("keywords");
    expect(caps).not.toContain("url-inspection");
  });

  it("a method called before an explicit load() still resolves correctly (never throws)", async () => {
    const fresh = new LocalExportSource(IMPORTS_DIR);
    const out = await fresh.searchAnalytics({
      siteUrl: "x",
      startDate: "",
      endDate: "",
      dimensions: ["query"],
    });
    expect(out.kind).toBe("data");
  });

  it("a missing export directory degrades every capability to disabled (never throws)", async () => {
    const missing = new LocalExportSource(join(IMPORTS_DIR, "does-not-exist-dir"));
    await expect(missing.load()).resolves.toEqual([]);
    const out = await missing.searchAnalytics({
      siteUrl: "x",
      startDate: "",
      endDate: "",
      dimensions: ["query"],
    });
    expect(out).toEqual({ kind: "disabled" });
  });
});

// ── LocalExportSource — offline link-graph arm (sc-7-4) ─────────────────

describe("LocalExportSource — offline link-graph arm (sc-7-4)", () => {
  it("present populated link-graph.csv => data + typed LinkGraphRow[] + provenance", async () => {
    const src = new LocalExportSource(IMPORTS_DIR);
    await src.load();

    const out = await src.linkGraph({ rootUrl: "https://example.com" });
    expect(out.kind).toBe("data");
    if (out.kind !== "data") return;
    expect(out.rows).toEqual([
      { fromUrl: "https://example.com/", toUrl: "https://example.com/about", anchor: "About us", internal: true },
      { fromUrl: "https://example.com/", toUrl: "https://external.example/partner", anchor: "Partner", internal: false },
    ]);
    expect(out.provenance.source).toBe("local-export");
    expect(out.provenance.path?.endsWith("link-graph.csv")).toBe(true);
    expect(typeof out.provenance.mtimeMs).toBe("number");
  });

  it("missing link-graph file => disabled (never throws)", async () => {
    const missing = new LocalExportSource(join(IMPORTS_DIR, "does-not-exist-dir"));
    await missing.load();
    await expect(missing.linkGraph({ rootUrl: "https://example.com" })).resolves.toEqual({ kind: "disabled" });
  });

  it("header-only link-graph.csv => abstain with a reason (empty export)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "local-export-link-graph-"));
    try {
      await writeFile(join(dir, "link-graph.csv"), "fromUrl,toUrl,anchor,internal\n");
      const src = new LocalExportSource(dir);
      await src.load();
      const out = await src.linkGraph({ rootUrl: "https://example.com" });
      expect(out.kind).toBe("abstain");
      if (out.kind !== "abstain") return;
      expect(typeof out.reason).toBe("string");
      expect(out.reason.length).toBeGreaterThan(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("capabilities() now includes link-graph alongside the other present-file arms", async () => {
    const src = new LocalExportSource(IMPORTS_DIR);
    const caps = await src.load();
    expect(caps).toContain("link-graph");
  });
});

// ── Zero-network (sc-6-2 + sc-6-5) ───────────────────────────────────────

describe("LocalExportSource — zero network", () => {
  it("never opens a socket — resolves data even if global fetch is forced to throw", async () => {
    const original = globalThis.fetch;
    // @ts-expect-error force any accidental network attempt to blow up loudly
    globalThis.fetch = () => {
      throw new Error("network forbidden in LocalExportSource");
    };
    try {
      const src = new LocalExportSource(IMPORTS_DIR);
      await src.load();
      const out = await src.searchAnalytics({
        siteUrl: "x",
        startDate: "",
        endDate: "",
        dimensions: ["query"],
      });
      expect(out.kind).toBe("data"); // offline path untouched by the throwing fetch
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ── parseCsv — hand-rolled CSV parser edge cases (sc-6-2) ────────────────

describe("parseCsv — pure/total CSV reader", () => {
  it("returns [] for empty input", () => {
    expect(parseCsv("")).toEqual([]);
  });

  it("returns [] for header-only input (no data rows)", () => {
    expect(parseCsv("a,b,c\n")).toEqual([]);
  });

  it("splits plain comma-separated rows into typed records", () => {
    expect(parseCsv("a,b\n1,2\n3,4")).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  it("keeps a quoted field containing a comma as ONE column", () => {
    const rows = parseCsv('city,country\n"Berlin, DE",Germany\n');
    expect(rows).toEqual([{ city: "Berlin, DE", country: "Germany" }]);
  });

  it("unescapes a doubled quote (\"\") into a literal quote inside a quoted field", () => {
    const rows = parseCsv('label,value\n"She said ""hi""",ok\n');
    expect(rows).toEqual([{ label: 'She said "hi"', value: "ok" }]);
  });

  it("tolerates CRLF line endings", () => {
    const rows = parseCsv("a,b\r\n1,2\r\n3,4\r\n");
    expect(rows).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  it("ignores a trailing blank line", () => {
    const rows = parseCsv("a,b\n1,2\n\n");
    expect(rows).toEqual([{ a: "1", b: "2" }]);
  });

  it("never throws on non-string input", () => {
    // @ts-expect-error deliberately pass a non-string to prove totality
    expect(parseCsv(null)).toEqual([]);
  });
});
