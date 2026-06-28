/**
 * Tests for supplements -> FactStore (sc-4-2, sc-4-3, sc-4-4).
 * Uses runSupplementAdd / runSupplementList with injected deps so no real
 * filesystem writes or clock reads are needed for the reconcile tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FactStore } from "../state/facts.js";
import {
  parseSupplementsFile,
  supplementToFact,
  runSupplementAdd,
  runSupplementList,
  DEFAULT_DOSE,
} from "./supplements.js";

// -- parseSupplementsFile ------------------------------------------------

describe("parseSupplementsFile", () => {
  it("parses a list of name|dose entries", () => {
    const raw =
      "---\nsupplements:\n  - Vitamin D | 1000 IU\n  - Magnesium | 200 mg\n---\n";
    const entries = parseSupplementsFile(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ name: "Vitamin D", dose: "1000 IU" });
    expect(entries[1]).toEqual({ name: "Magnesium", dose: "200 mg" });
  });

  it("defaults dose to undefined when no pipe separator", () => {
    const raw = "---\nsupplements:\n  - Omega 3\n---\n";
    const entries = parseSupplementsFile(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ name: "Omega 3", dose: undefined });
  });

  it("returns empty array for empty supplements list", () => {
    const raw = "---\nsupplements:\n---\n";
    const entries = parseSupplementsFile(raw);
    expect(entries).toHaveLength(0);
  });

  it("throws on missing opening fence", () => {
    expect(() => parseSupplementsFile("no fence")).toThrow(
      "missing opening '---' fence",
    );
  });

  it("throws on missing closing fence", () => {
    expect(() => parseSupplementsFile("---\nsupplements:\n  - X | Y\n")).toThrow(
      "missing closing '---' fence",
    );
  });
});

// -- supplementToFact ----------------------------------------------------

describe("supplementToFact", () => {
  const now = "2026-06-15T00:00:00.000Z";

  it("builds a FactInput with scope=medical, subject=name, predicate=dose, value=dose", () => {
    const input = supplementToFact("Vitamin D", "1000 IU", now);
    expect(input.scope).toBe("medical");
    expect(input.subject).toBe("Vitamin D");
    expect(input.predicate).toBe("dose");
    expect(input.value).toBe("1000 IU");
    expect(input.confidence).toBe(1);
    expect(input.sourceRunId).toBeNull();
    expect(input.tValid).toBe(now);
    expect(input.tCreated).toBe(now);
  });

  it("uses DEFAULT_DOSE placeholder when dose is undefined", () => {
    const input = supplementToFact("Omega 3", undefined, now);
    expect(input.value).toBe(DEFAULT_DOSE);
    expect(DEFAULT_DOSE).toBe("unspecified");
    expect(DEFAULT_DOSE.length).toBeGreaterThan(0); // FactSchema value.min(1)
  });
});

// -- runSupplementAdd (sc-4-2, sc-4-3) -----------------------------------

describe("runSupplementAdd", () => {
  let store: FactStore;

  afterEach(() => {
    store?.close();
  });

  it("sc-4-2: reconciles a supplement into FactStore — getActiveFacts returns the new fact", async () => {
    store = new FactStore(":memory:");
    const now = "2026-06-15T00:00:00.000Z";

    await runSupplementAdd(
      "/root",
      "Vitamin D",
      { dose: "1000 IU" },
      { store, now },
    );

    const active = store.getActiveFacts("medical");
    expect(active).toHaveLength(1);
    expect(active[0]!.scope).toBe("medical");
    expect(active[0]!.subject).toBe("Vitamin D");
    expect(active[0]!.predicate).toBe("dose");
    expect(active[0]!.value).toBe("1000 IU");
  });

  it("sc-4-2: getActiveFacts with explicit subject+predicate also returns the fact", async () => {
    store = new FactStore(":memory:");
    const now = "2026-06-15T00:00:00.000Z";

    await runSupplementAdd(
      "/root",
      "Magnesium",
      { dose: "200 mg" },
      { store, now },
    );

    const active = store.getActiveFacts("medical", "Magnesium", "dose");
    expect(active).toHaveLength(1);
    expect(active[0]!.value).toBe("200 mg");
  });

  it("sc-4-3: re-running runSupplementAdd with the same name+dose is a NOOP — count stays at 1", async () => {
    store = new FactStore(":memory:");
    const now = "2026-06-15T00:00:00.000Z";

    await runSupplementAdd(
      "/root",
      "Vitamin D",
      { dose: "1000 IU" },
      { store, now },
    );
    expect(store.getActiveFacts("medical")).toHaveLength(1);

    // Re-add identical name+dose — reconcileFact exact-match NOOP, no second row
    await runSupplementAdd(
      "/root",
      "Vitamin D",
      { dose: "1000 IU" },
      { store, now },
    );
    expect(store.getActiveFacts("medical")).toHaveLength(1); // sc-4-3: still exactly 1
  });

  it("dose defaults to DEFAULT_DOSE placeholder when omitted (value.min(1) satisfied)", async () => {
    store = new FactStore(":memory:");
    const now = "2026-06-15T00:00:00.000Z";

    await runSupplementAdd("/root", "CoQ10", {}, { store, now });

    const active = store.getActiveFacts("medical", "CoQ10", "dose");
    expect(active).toHaveLength(1);
    expect(active[0]!.value).toBe(DEFAULT_DOSE);
  });

  it("adding a different supplement is a separate ADD — count grows to 2", async () => {
    store = new FactStore(":memory:");
    const now = "2026-06-15T00:00:00.000Z";

    await runSupplementAdd(
      "/root",
      "Vitamin D",
      { dose: "1000 IU" },
      { store, now },
    );
    await runSupplementAdd(
      "/root",
      "Magnesium",
      { dose: "200 mg" },
      { store, now },
    );

    expect(store.getActiveFacts("medical")).toHaveLength(2);
  });
});

// -- runSupplementList (sc-4-4) ------------------------------------------

describe("runSupplementList", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "bober-supp-"));
    process.exitCode = 0;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("sc-4-4: parses seeded file and writes each supplement name+dose to stdout", async () => {
    const suppPath = join(tmpDir, "supplements.md");
    await writeFile(
      suppPath,
      "---\nsupplements:\n  - Vitamin D | 1000 IU\n  - Magnesium | 200 mg\n---\n",
      "utf-8",
    );

    const stdoutWrites: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        stdoutWrites.push(String(chunk));
        return true;
      });

    await runSupplementList(tmpDir, { file: suppPath });
    stdoutSpy.mockRestore();

    const out = stdoutWrites.join("");
    expect(out).toContain("Vitamin D");
    expect(out).toContain("1000 IU");
    expect(out).toContain("Magnesium");
    expect(out).toContain("200 mg");
  });

  it("writes an empty-state message when the file has no entries", async () => {
    const suppPath = join(tmpDir, "supplements.md");
    await writeFile(suppPath, "---\nsupplements:\n---\n", "utf-8");

    const stdoutWrites: string[] = [];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        stdoutWrites.push(String(chunk));
        return true;
      });

    await runSupplementList(tmpDir, { file: suppPath });
    stdoutSpy.mockRestore();

    const out = stdoutWrites.join("");
    expect(out).toContain("No supplements found");
  });

  it("sets process.exitCode=1 and writes to stderr when the file is missing", async () => {
    const stderrWrites: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
      });

    await runSupplementList(tmpDir, { file: join(tmpDir, "nonexistent.md") });
    stderrSpy.mockRestore();

    expect(process.exitCode).toBe(1);
    expect(stderrWrites.join("")).toContain("Failed to list supplements");
  });
});
