import { describe, it, expect, afterEach } from "vitest";
import { FactStore } from "../../state/facts.js";
import { writeFact } from "./reconcile.js";
import { detectProjectFacts } from "./fact-detector.js";
import type { ProjectInputs } from "./fact-detector.js";

// ── Fixtures ──────────────────────────────────────────────────────────────

/** A synthetic fixture that exercises all four detection rules independently of repo state. */
const FIXTURE_PKG: Record<string, unknown> = {
  scripts: {
    test: "vitest run",
    build: "tsc",
  },
  dependencies: {
    react: "^18.0.0",
  },
  devDependencies: {
    typescript: "^5.0.0",
  },
};

const FIXTURE_INPUTS: ProjectInputs = {
  packageJson: FIXTURE_PKG,
  lockfiles: { npm: true, yarn: false, pnpm: false },
};

const FIXTURE_NEXT_INPUTS: ProjectInputs = {
  packageJson: {
    scripts: { test: "jest", build: "next build" },
    dependencies: { next: "14.0.0", react: "^18.0.0" },
  },
  lockfiles: { npm: false, yarn: true, pnpm: false },
};

// ── sc-5-2: detectProjectFacts is PURE and produces expected drafts ────────

describe("detectProjectFacts — sc-5-2: pure function, expected drafts", () => {
  it("maps scripts.test → project/testCommand", () => {
    const drafts = detectProjectFacts(FIXTURE_INPUTS);
    const match = drafts.find((d) => d.predicate === "project/testCommand");
    expect(match).toBeDefined();
    expect(match?.value).toBe("vitest run");
    expect(match?.subject).toBe("project");
    expect(match?.scope).toBe("");
  });

  it("maps scripts.build → project/buildCommand", () => {
    const drafts = detectProjectFacts(FIXTURE_INPUTS);
    const match = drafts.find((d) => d.predicate === "project/buildCommand");
    expect(match).toBeDefined();
    expect(match?.value).toBe("tsc");
  });

  it("maps package-lock.json presence → project/packageManager = npm", () => {
    const drafts = detectProjectFacts(FIXTURE_INPUTS);
    const match = drafts.find((d) => d.predicate === "project/packageManager");
    expect(match).toBeDefined();
    expect(match?.value).toBe("npm");
  });

  it("maps react dep → project/framework = react", () => {
    const drafts = detectProjectFacts(FIXTURE_INPUTS);
    const match = drafts.find((d) => d.predicate === "project/framework");
    expect(match).toBeDefined();
    expect(match?.value).toBe("react");
  });

  it("next dep takes priority over react in framework detection", () => {
    const drafts = detectProjectFacts(FIXTURE_NEXT_INPUTS);
    const match = drafts.find((d) => d.predicate === "project/framework");
    expect(match?.value).toBe("next");
  });

  it("yarn.lock → packageManager = yarn", () => {
    const drafts = detectProjectFacts(FIXTURE_NEXT_INPUTS);
    const match = drafts.find((d) => d.predicate === "project/packageManager");
    expect(match?.value).toBe("yarn");
  });

  it("pnpm-lock.yaml → packageManager = pnpm (only pnpm present)", () => {
    const drafts = detectProjectFacts({
      packageJson: null,
      lockfiles: { npm: false, yarn: false, pnpm: true },
    });
    const match = drafts.find((d) => d.predicate === "project/packageManager");
    expect(match?.value).toBe("pnpm");
  });

  it("returns [] when packageJson is null and no lockfiles", () => {
    const drafts = detectProjectFacts({ packageJson: null });
    expect(drafts).toEqual([]);
  });

  it("omits missing scripts (no error)", () => {
    const drafts = detectProjectFacts({
      packageJson: { scripts: {} },
    });
    expect(drafts.find((d) => d.predicate === "project/testCommand")).toBeUndefined();
    expect(drafts.find((d) => d.predicate === "project/buildCommand")).toBeUndefined();
  });

  it("omits framework when no react/next/vue dep", () => {
    const drafts = detectProjectFacts({
      packageJson: { scripts: { test: "jest" }, dependencies: { lodash: "^4.0.0" } },
    });
    expect(drafts.find((d) => d.predicate === "project/framework")).toBeUndefined();
  });

  it("uses scope='' by default and custom scope when provided", () => {
    const defaultDrafts = detectProjectFacts(FIXTURE_INPUTS);
    expect(defaultDrafts.every((d) => d.scope === "")).toBe(true);

    const customDrafts = detectProjectFacts(FIXTURE_INPUTS, "programming");
    expect(customDrafts.every((d) => d.scope === "programming")).toBe(true);
  });

  it("all drafts have confidence=1 and sourceRunId=null", () => {
    const drafts = detectProjectFacts(FIXTURE_INPUTS);
    for (const d of drafts) {
      expect(d.confidence).toBe(1);
      expect(d.sourceRunId).toBeNull();
    }
  });

  it("does not include tValid or tCreated in drafts (caller stamps those)", () => {
    const drafts = detectProjectFacts(FIXTURE_INPUTS);
    for (const d of drafts) {
      expect(d).not.toHaveProperty("tValid");
      expect(d).not.toHaveProperty("tCreated");
    }
  });
});

// ── sc-5-3: idempotency via writeFact — NOOP on unchanged, supersede on changed ──

describe("detectProjectFacts + writeFact — sc-5-3: double-reconcile idempotency", () => {
  let store: FactStore;

  afterEach(() => {
    store?.close();
  });

  it("running the detector twice produces no duplicates (NOOP on unchanged)", async () => {
    store = new FactStore(":memory:");
    const now = "2026-06-15T00:00:00.000Z";

    const drafts = detectProjectFacts(FIXTURE_INPUTS);
    expect(drafts.length).toBeGreaterThan(0);

    // First write — all become "add"
    for (const d of drafts) {
      const action = await writeFact(store, { ...d, tValid: now, tCreated: now }, { now });
      expect(action).toBe("add");
    }

    // Second write with identical values — all become "noop"
    for (const d of drafts) {
      const action = await writeFact(store, { ...d, tValid: now, tCreated: now }, { now });
      expect(action).toBe("noop");
    }

    // One active row per predicate — no duplicates
    const testCmd = store.getActiveFacts("", "project", "project/testCommand");
    expect(testCmd).toHaveLength(1);
    expect(testCmd[0]?.value).toBe("vitest run");
  });

  it("changed script value causes supersede ('update') with one active row per predicate", async () => {
    store = new FactStore(":memory:");
    const t1 = "2026-06-15T00:00:00.000Z";
    const t2 = "2026-06-16T00:00:00.000Z";

    // First detection: vitest run
    const drafts1 = detectProjectFacts(FIXTURE_INPUTS);
    for (const d of drafts1) {
      await writeFact(store, { ...d, tValid: t1, tCreated: t1 }, { now: t1 });
    }

    // Second detection: script changed to "jest"
    const drafts2 = detectProjectFacts({
      ...FIXTURE_INPUTS,
      packageJson: { ...FIXTURE_PKG, scripts: { test: "jest", build: "tsc" } },
    });
    let updateCount = 0;
    for (const d of drafts2) {
      const action = await writeFact(store, { ...d, tValid: t2, tCreated: t2 }, { now: t2 });
      if (action === "update") updateCount++;
    }
    // The testCommand predicate changed → at least one update
    expect(updateCount).toBeGreaterThanOrEqual(1);

    // One active row per predicate — no duplicates
    const testCmd = store.getActiveFacts("", "project", "project/testCommand");
    expect(testCmd).toHaveLength(1);
    expect(testCmd[0]?.value).toBe("jest");
  });
});

// ── sc-5-2: purity assertions (no fs, no Date, no createClient in pure fn) ──

describe("fact-detector.ts purity assertions (sc-5-2)", () => {
  it("detectProjectFacts function body does not CALL Date.now() or new Date()", async () => {
    // Read only the pure fn section — up to the seedProjectFacts boundary
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      new URL("./fact-detector.ts", import.meta.url),
      "utf-8",
    );
    // Extract just the detectProjectFacts function (before seedProjectFacts)
    const pureFnStart = source.indexOf("export function detectProjectFacts");
    const ioStart = source.indexOf("export async function seedProjectFacts");
    const pureFnBody = source.slice(pureFnStart, ioStart > 0 ? ioStart : undefined);

    expect(pureFnBody).not.toMatch(/Date\.now\(\)/);
    expect(pureFnBody).not.toMatch(/new Date\(\)/);
  });

  it("detectProjectFacts function body does not CALL createClient or fetch", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(
      new URL("./fact-detector.ts", import.meta.url),
      "utf-8",
    );
    const pureFnStart = source.indexOf("export function detectProjectFacts");
    const ioStart = source.indexOf("export async function seedProjectFacts");
    const pureFnBody = source.slice(pureFnStart, ioStart > 0 ? ioStart : undefined);

    expect(pureFnBody).not.toMatch(/createClient/);
    expect(pureFnBody).not.toMatch(/\bfetch\(/);
    expect(pureFnBody).not.toMatch(/readFile/);
  });
});
