import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDo } from "./do.js";
import { InMemoryFindingStore } from "../../do-bridge/finding-port.js";
import { PromoterRegistry } from "../../do-bridge/registry.js";
import { codingPromoter } from "../../do-bridge/coding-promoter.js";
import type { Launcher } from "../../do-bridge/launcher.js";
import type { PromotionPlan } from "../../do-bridge/types.js";
import type { Finding } from "../../hub/finding.js";

const T = "2026-06-28T00:00:00.000Z";

const CODING_FINDING: Finding = {
  id: "abc123def456abc1",
  domain: "coding",
  title: "fix the CI build",
  kind: "action",
  urgency: 3,
  severity: 2,
  evidence: [],
  surfacedAt: T,
  tags: [],
  status: "open",
};

const MEDICAL_FINDING: Finding = {
  id: "medicalfindingid1",
  domain: "medical",
  title: "review lab results",
  kind: "action",
  urgency: 2,
  severity: 3,
  evidence: [],
  surfacedAt: T,
  tags: [],
  status: "open",
};

const originalExitCode = process.exitCode;

beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode as number | undefined;
});

// ── Helper to build a standard coding registry ────────────────────────

function buildCodingRegistry(): PromoterRegistry {
  const registry = new PromoterRegistry();
  registry.register({ domain: "coding" }, codingPromoter);
  registry.register({ domain: "projects" }, codingPromoter);
  return registry;
}

// ── sc-1-4: dry-run prints task + "dry-run" with zero writes ─────────

describe("runDo — sc-1-4: dry-run path", () => {
  it("prints a line containing the resolved task string", async () => {
    const store = new InMemoryFindingStore([CODING_FINDING]);
    const registry = buildCodingRegistry();
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });

    await runDo(store, registry, CODING_FINDING.id, { dryRun: true });

    const combined = stdoutWrites.join("");
    // Must contain the resolved task (derived from finding title)
    expect(combined).toContain(CODING_FINDING.title);
    // Must contain "dry-run" (sc-1-4)
    expect(combined).toContain("dry-run");
    expect(process.exitCode).toBe(0);
  });

  it("records zero writes to the store (no mutation)", async () => {
    const store = new InMemoryFindingStore([CODING_FINDING]);
    const registry = buildCodingRegistry();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runDo(store, registry, CODING_FINDING.id, { dryRun: true });

    // The fake store must show zero writes (sc-1-4)
    expect(store.writes).toHaveLength(0);
  });

  it("names the team when the finding has a team tag", async () => {
    const findingWithTeam: Finding = {
      ...CODING_FINDING,
      id: "teamfinding0001234",
      tags: ["team:backend"],
    };
    const store = new InMemoryFindingStore([findingWithTeam]);
    const registry = buildCodingRegistry();
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });

    await runDo(store, registry, findingWithTeam.id, { dryRun: true });

    const combined = stdoutWrites.join("");
    expect(combined).toContain("backend");
  });

  it("shows 'default team' when no team tag is present", async () => {
    const store = new InMemoryFindingStore([CODING_FINDING]);
    const registry = buildCodingRegistry();
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });

    await runDo(store, registry, CODING_FINDING.id, { dryRun: true });

    const combined = stdoutWrites.join("");
    expect(combined).toContain("default team");
  });
});

// ── sc-1-5: unsupported domain → exitCode 1 naming the domain ────────

describe("runDo — sc-1-5: unsupported domain path", () => {
  it("sets process.exitCode=1 when domain has no registered promoter", async () => {
    const store = new InMemoryFindingStore([MEDICAL_FINDING]);
    const registry = buildCodingRegistry(); // coding/projects only
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runDo(store, registry, MEDICAL_FINDING.id, { dryRun: true });

    expect(process.exitCode).toBe(1);
  });

  it("names the unsupported (domain, kind) pair in the error message", async () => {
    const store = new InMemoryFindingStore([MEDICAL_FINDING]);
    const registry = buildCodingRegistry();
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    await runDo(store, registry, MEDICAL_FINDING.id, { dryRun: true });

    const combined = stderrWrites.join("");
    // Must name the domain (sc-1-5) AND the kind (sc-3-4) so an operator can
    // distinguish a missing domain-only vs kind-specific registration.
    expect(combined).toContain("medical");
    expect(combined).toContain(MEDICAL_FINDING.kind); // "action"
  });

  it("does not write anything to stdout on unsupported domain", async () => {
    const store = new InMemoryFindingStore([MEDICAL_FINDING]);
    const registry = buildCodingRegistry();
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutWrites.push(String(chunk));
      return true;
    });

    await runDo(store, registry, MEDICAL_FINDING.id, { dryRun: true });

    expect(stdoutWrites).toHaveLength(0);
  });
});

// ── Unknown finding id ────────────────────────────────────────────────

describe("runDo — unknown finding id", () => {
  it("sets process.exitCode=1 when finding is not found", async () => {
    const store = new InMemoryFindingStore([]);
    const registry = buildCodingRegistry();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await runDo(store, registry, "nonexistent-id-xyz", { dryRun: true });

    expect(process.exitCode).toBe(1);
  });

  it("writes an error referencing the unknown id", async () => {
    const store = new InMemoryFindingStore([]);
    const registry = buildCodingRegistry();
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    await runDo(store, registry, "nonexistent-id-xyz", { dryRun: true });

    expect(stderrWrites.join("")).toContain("nonexistent-id-xyz");
  });
});

// ── Sprint 2: real launch path ────────────────────────────────────────

/** Fake Launcher that records calls and never spawns a real process. */
function makeFakeLauncher(runId = "do-x-1") {
  const calls: PromotionPlan[] = [];
  const launcher: Launcher = {
    async launch(plan: PromotionPlan) {
      calls.push(plan);
      return { runId, pid: 4242 };
    },
  };
  return { launcher, calls };
}

// ── sc-2-2: approve → launch once → markers correct ──────────────────

describe("runDo — sc-2-2: approve path launches exactly once and writes markers", () => {
  it("calls launcher.launch exactly once with the promoter task", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "bober-do-sc22-"));
    try {
      const { launcher, calls } = makeFakeLauncher("do-abc-123");
      const store = new InMemoryFindingStore([CODING_FINDING]);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      await runDo(store, buildCodingRegistry(), CODING_FINDING.id, { yes: true }, {
        launcher,
        projectRoot,
        confirm: async () => true,
        isTTY: false,
        now: () => T,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0]!.task).toBe(CODING_FINDING.title);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

// ── sc-2-3: approve → finding status + promotesTo ────────────────────

describe("runDo — sc-2-3: approve sets status=in-progress and promotesTo", () => {
  it("finding status is in-progress after approve", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "bober-do-sc23-"));
    try {
      const { launcher } = makeFakeLauncher("do-abc-123");
      const store = new InMemoryFindingStore([CODING_FINDING]);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      await runDo(store, buildCodingRegistry(), CODING_FINDING.id, { yes: true }, {
        launcher,
        projectRoot,
        confirm: async () => true,
        isTTY: false,
        now: () => T,
      });

      const f = await store.readFinding(CODING_FINDING.id);
      expect(f!.status).toBe("in-progress");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("promotesTo.runId matches the runId from the fake launcher", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "bober-do-sc23b-"));
    try {
      const FAKE_RUN_ID = "do-abc123-fakerun";
      const { launcher } = makeFakeLauncher(FAKE_RUN_ID);
      const store = new InMemoryFindingStore([CODING_FINDING]);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      await runDo(store, buildCodingRegistry(), CODING_FINDING.id, { yes: true }, {
        launcher,
        projectRoot,
        confirm: async () => true,
        isTTY: false,
        now: () => T,
      });

      const f = await store.readFinding(CODING_FINDING.id);
      expect(f!.promotesTo).toMatchObject({ runId: FAKE_RUN_ID, status: "launched" });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("store.writes has exactly one entry after approve", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "bober-do-sc23c-"));
    try {
      const { launcher } = makeFakeLauncher("do-abc-123");
      const store = new InMemoryFindingStore([CODING_FINDING]);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);

      await runDo(store, buildCodingRegistry(), CODING_FINDING.id, { yes: true }, {
        launcher,
        projectRoot,
        confirm: async () => true,
        isTTY: false,
        now: () => T,
      });

      expect(store.writes).toHaveLength(1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

// ── sc-2-4: reject → launch zero times, finding unchanged ────────────

describe("runDo — sc-2-4: reject path", () => {
  it("calls launcher.launch zero times when user rejects", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "bober-do-sc24-"));
    try {
      const { launcher, calls } = makeFakeLauncher("do-abc-123");
      const store = new InMemoryFindingStore([CODING_FINDING]);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      // TTY mode with confirm returning false → reject
      await runDo(store, buildCodingRegistry(), CODING_FINDING.id, { yes: false }, {
        launcher,
        projectRoot,
        confirm: async () => false,
        isTTY: true,
        now: () => T,
      });

      expect(calls).toHaveLength(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("finding status stays 'open' after reject", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "bober-do-sc24b-"));
    try {
      const { launcher } = makeFakeLauncher("do-abc-123");
      const store = new InMemoryFindingStore([CODING_FINDING]);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      await runDo(store, buildCodingRegistry(), CODING_FINDING.id, { yes: false }, {
        launcher,
        projectRoot,
        confirm: async () => false,
        isTTY: true,
        now: () => T,
      });

      const f = await store.readFinding(CODING_FINDING.id);
      expect(f!.status).toBe("open");
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("store.writes has zero entries after reject (finding not mutated)", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "bober-do-sc24c-"));
    try {
      const { launcher } = makeFakeLauncher("do-abc-123");
      const store = new InMemoryFindingStore([CODING_FINDING]);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      await runDo(store, buildCodingRegistry(), CODING_FINDING.id, { yes: false }, {
        launcher,
        projectRoot,
        confirm: async () => false,
        isTTY: true,
        now: () => T,
      });

      expect(store.writes).toHaveLength(0);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
