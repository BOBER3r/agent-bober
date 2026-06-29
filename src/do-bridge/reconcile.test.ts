import { describe, it, expect } from "vitest";
import { reconcilePromotions } from "./reconcile.js";
import { InMemoryFindingStore } from "./finding-port.js";
import type { Finding } from "../hub/finding.js";
import type { RunState } from "../mcp/run-manager.js";

const T = "2026-06-28T00:00:00.000Z";

// A finding already promoted by Sprint 2: status in-progress + a 'launched' ref
// stored as a JSON string (the constructor runs it through toDoFinding, which
// parses it into a PromotionRef object — so readFinding returns the object).
const LAUNCHED: Finding = {
  id: "abc123def456abc1",
  domain: "coding",
  title: "fix the CI build",
  kind: "action",
  urgency: 3,
  severity: 2,
  evidence: [],
  surfacedAt: T,
  tags: [],
  status: "in-progress",
  promotesTo: JSON.stringify({
    kind: "bober-run",
    runId: "do-abc-1",
    launchedAt: T,
    status: "launched",
  }),
};

// Minimal RunState fake — reconcile only reads .status.
function fakeState(status: RunState["status"]): RunState {
  return {
    runId: "do-abc-1",
    task: "x",
    status,
    startedAt: T,
    progress: { completed: 0, total: 0 },
    projectRoot: "/x",
  };
}

// ── sc-3-2: completed run → finding done ─────────────────────────────

describe("reconcilePromotions — sc-3-2: completed run", () => {
  it("transitions finding to 'done' when run status is 'completed'", async () => {
    const store = new InMemoryFindingStore([LAUNCHED]);
    await reconcilePromotions({
      store,
      readState: async () => fakeState("completed"),
      now: () => T,
    });
    const f = await store.readFinding("abc123def456abc1");
    expect(f!.status).toBe("done");
  });

  it("sets promotesTo.status to 'completed' after a completed run", async () => {
    const store = new InMemoryFindingStore([LAUNCHED]);
    await reconcilePromotions({
      store,
      readState: async () => fakeState("completed"),
      now: () => T,
    });
    const f = await store.readFinding("abc123def456abc1");
    expect(f!.promotesTo).toMatchObject({ status: "completed" });
  });

  it("returns summary with completed=1 aborted=0 unchanged=0", async () => {
    const store = new InMemoryFindingStore([LAUNCHED]);
    const summary = await reconcilePromotions({
      store,
      readState: async () => fakeState("completed"),
      now: () => T,
    });
    expect(summary).toMatchObject({ completed: 1, aborted: 0, unchanged: 0 });
  });
});

// ── sc-3-3: aborted run → finding open ───────────────────────────────

describe("reconcilePromotions — sc-3-3: aborted run", () => {
  it("returns finding to 'open' when run status is 'aborted'", async () => {
    const store = new InMemoryFindingStore([LAUNCHED]);
    await reconcilePromotions({
      store,
      readState: async () => fakeState("aborted"),
      now: () => T,
    });
    const f = await store.readFinding("abc123def456abc1");
    expect(f!.status).toBe("open");
  });

  it("sets promotesTo.status to 'aborted' after an aborted run", async () => {
    const store = new InMemoryFindingStore([LAUNCHED]);
    await reconcilePromotions({
      store,
      readState: async () => fakeState("aborted"),
      now: () => T,
    });
    const f = await store.readFinding("abc123def456abc1");
    expect(f!.promotesTo).toMatchObject({ status: "aborted" });
  });

  it("returns finding to 'open' when run status is 'failed'", async () => {
    const store = new InMemoryFindingStore([LAUNCHED]);
    await reconcilePromotions({
      store,
      readState: async () => fakeState("failed"),
      now: () => T,
    });
    const f = await store.readFinding("abc123def456abc1");
    expect(f!.status).toBe("open");
  });

  it("returns summary with completed=0 aborted=1 unchanged=0 for aborted run", async () => {
    const store = new InMemoryFindingStore([LAUNCHED]);
    const summary = await reconcilePromotions({
      store,
      readState: async () => fakeState("aborted"),
      now: () => T,
    });
    expect(summary).toMatchObject({ completed: 0, aborted: 1, unchanged: 0 });
  });
});

// ── sc-3-3: running run → finding unchanged ───────────────────────────

describe("reconcilePromotions — sc-3-3: running run", () => {
  it("leaves finding at 'in-progress' when run status is 'running'", async () => {
    const store = new InMemoryFindingStore([LAUNCHED]);
    await reconcilePromotions({
      store,
      readState: async () => fakeState("running"),
      now: () => T,
    });
    const f = await store.readFinding("abc123def456abc1");
    expect(f!.status).toBe("in-progress");
  });

  it("leaves promotesTo.status as 'launched' when run is still running", async () => {
    const store = new InMemoryFindingStore([LAUNCHED]);
    await reconcilePromotions({
      store,
      readState: async () => fakeState("running"),
      now: () => T,
    });
    const f = await store.readFinding("abc123def456abc1");
    expect(f!.promotesTo).toMatchObject({ status: "launched" });
  });

  it("records zero writes when run is still running (no mutation)", async () => {
    const store = new InMemoryFindingStore([LAUNCHED]);
    await reconcilePromotions({
      store,
      readState: async () => fakeState("running"),
      now: () => T,
    });
    expect(store.writes).toHaveLength(0);
  });

  it("returns summary with unchanged=1 for a running run", async () => {
    const store = new InMemoryFindingStore([LAUNCHED]);
    const summary = await reconcilePromotions({
      store,
      readState: async () => fakeState("running"),
      now: () => T,
    });
    expect(summary).toMatchObject({ completed: 0, aborted: 0, unchanged: 1 });
  });
});

// ── missing run-state (null) → never throws, finding unchanged ────────

describe("reconcilePromotions — missing run-state", () => {
  it("resolves without throwing when readState returns null", async () => {
    const store = new InMemoryFindingStore([LAUNCHED]);
    await expect(
      reconcilePromotions({
        store,
        readState: async () => null,
        now: () => T,
      }),
    ).resolves.toBeDefined();
  });

  it("leaves finding unchanged when run-state is null", async () => {
    const store = new InMemoryFindingStore([LAUNCHED]);
    await reconcilePromotions({
      store,
      readState: async () => null,
      now: () => T,
    });
    const f = await store.readFinding("abc123def456abc1");
    expect(f!.status).toBe("in-progress");
  });

  it("records zero writes when run-state is null", async () => {
    const store = new InMemoryFindingStore([LAUNCHED]);
    await reconcilePromotions({
      store,
      readState: async () => null,
      now: () => T,
    });
    expect(store.writes).toHaveLength(0);
  });

  it("returns summary with unchanged=1 when run-state is null", async () => {
    const store = new InMemoryFindingStore([LAUNCHED]);
    const summary = await reconcilePromotions({
      store,
      readState: async () => null,
      now: () => T,
    });
    expect(summary).toMatchObject({ completed: 0, aborted: 0, unchanged: 1 });
  });
});
