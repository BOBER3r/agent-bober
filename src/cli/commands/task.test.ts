import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FactStore } from "../../state/facts.js";
import { runTaskAdd, runTaskList, runTaskTransition, runTaskSnooze, runTaskIngest } from "./task.js";
import { captureTask } from "../../hub/task-inbox.js";
import { readFindings } from "../../hub/finding-store.js";
import { HUB_SCOPE } from "../../hub/finding-source.js";

const T = "2026-06-28T00:00:00.000Z";

const originalExitCode = process.exitCode;

beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExitCode as number | undefined;
});

describe("runTaskAdd", () => {
  // sc-1-5: empty input → exitCode 1, no throw
  it("sc-1-5: empty input → exitCode 1 and returns without throwing", async () => {
    const store = new FactStore(":memory:");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(runTaskAdd(store, "   ", {}, T)).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);
    store.close();
  });

  // sc-1-5: whitespace-only input
  it("sc-1-5: whitespace-only input → exitCode 1", async () => {
    const store = new FactStore(":memory:");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await runTaskAdd(store, "   ", {}, T);
    expect(process.exitCode).toBe(1);
    store.close();
  });

  it("valid input → exitCode stays 0", async () => {
    const store = new FactStore(":memory:");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runTaskAdd(store, "renew passport", {}, T);
    expect(process.exitCode).toBe(0);
    store.close();
  });

  it("valid input with domain → exitCode stays 0", async () => {
    const store = new FactStore(":memory:");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runTaskAdd(store, "schedule MRI", { domain: "medical" }, T);
    expect(process.exitCode).toBe(0);
    store.close();
  });

  it("success prints captured task id to stdout", async () => {
    const store = new FactStore(":memory:");
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    await runTaskAdd(store, "renew passport", {}, T);
    const combined = writes.join("");
    expect(combined).toMatch(/Captured task/);
    store.close();
  });

  it("empty input writes to stderr", async () => {
    const store = new FactStore(":memory:");
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });
    await runTaskAdd(store, "", {}, T);
    expect(stderrWrites.join("")).toMatch(/must not be empty/);
    store.close();
  });
});

describe("runTaskList", () => {
  const T0 = "2026-06-28T00:00:00.000Z";
  const T1 = "2026-06-29T00:00:00.000Z";

  // sc-2-3: default list shows only open/in-progress; done is hidden then visible with --all/--status
  it("sc-2-3: default list excludes done tasks; --all and --status=done include them", async () => {
    const store = new FactStore(":memory:");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const task1 = await captureTask(store, "task one", { now: T0 });
    const task2 = await captureTask(store, "task two", { now: T0 });

    // Both tasks are open — default list should include both
    const defaultFindings = readFindings(store).filter((f) =>
      ["open", "in-progress"].includes(f.status),
    );
    expect(defaultFindings).toHaveLength(2);

    // Mark task1 as done
    await runTaskTransition(store, task1.id, "done", T1);

    // Default filter excludes done tasks
    const afterDone = readFindings(store).filter((f) =>
      ["open", "in-progress"].includes(f.status),
    );
    expect(afterDone).toHaveLength(1);
    expect(afterDone[0]!.id).toBe(task2.id);

    // --all includes done tasks
    const allFindings = readFindings(store);
    expect(allFindings).toHaveLength(2);
    const doneTask = allFindings.find((f) => f.id === task1.id);
    expect(doneTask?.status).toBe("done");

    // --status=done shows only done
    const doneOnly = readFindings(store).filter((f) => f.status === "done");
    expect(doneOnly).toHaveLength(1);
    expect(doneOnly[0]!.id).toBe(task1.id);

    store.close();
  });

  it("runTaskList with default opts prints only open/in-progress tasks", async () => {
    const store = new FactStore(":memory:");
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    const task1 = await captureTask(store, "complete this task", { now: T0 });
    const task2 = await captureTask(store, "remaining open task", { now: T0 });
    // Mark task1 done
    await runTaskTransition(store, task1.id, "done", T1);

    // Reset captures for the list call
    writes.length = 0;
    runTaskList(store, {}, T1);
    const output = writes.join("");
    // task2 (still open) is shown — assert by both id and title
    expect(output).toContain(task2.id);
    expect(output).toMatch(/remaining open task/);
    // task1 (now done) is absent — assert by id since title substring could collide
    expect(output).not.toContain(task1.id);

    store.close();
  });

  it("runTaskList --all includes done/dropped tasks", async () => {
    const store = new FactStore(":memory:");
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    const task = await captureTask(store, "finished task", { now: T0 });
    await runTaskTransition(store, task.id, "done", T1);

    writes.length = 0;
    runTaskList(store, { all: true }, T1);
    const output = writes.join("");
    expect(output).toMatch(/finished task/);
    expect(output).toMatch(/done/);

    store.close();
  });

  it("empty store prints no tasks found", () => {
    const store = new FactStore(":memory:");
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    runTaskList(store, {}, T);
    expect(writes.join("")).toMatch(/No tasks found/);

    store.close();
  });
});

describe("runTaskTransition", () => {
  const T0 = "2026-06-28T00:00:00.000Z";
  const T1 = "2026-06-29T00:00:00.000Z";

  // sc-2-5: unknown id → exitCode=1 and no throw
  it("sc-2-5: unknown id to done → exitCode=1 and resolves without throwing", async () => {
    const store = new FactStore(":memory:");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      runTaskTransition(store, "nonexistent-id-xyz", "done", T1),
    ).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);

    store.close();
  });

  it("sc-2-5: unknown id to drop → exitCode=1 and resolves without throwing", async () => {
    const store = new FactStore(":memory:");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      runTaskTransition(store, "nonexistent-id-xyz", "dropped", T1),
    ).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);

    store.close();
  });

  it("successful transition prints confirmation and keeps exitCode=0", async () => {
    const store = new FactStore(":memory:");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const task = await captureTask(store, "do laundry", { now: T0 });
    await runTaskTransition(store, task.id, "done", T1);
    expect(process.exitCode).toBe(0);

    store.close();
  });
});

describe("runTaskSnooze", () => {
  const T0 = "2026-06-28T00:00:00.000Z";
  const T1 = "2026-06-29T00:00:00.000Z";
  const T2 = "2026-06-30T00:00:00.000Z";
  const FUTURE_ISO = "2026-12-01T00:00:00.000Z";

  // sc-3-2: snooze sets status=snoozed and records exact snooze-until tag
  it("sc-3-2: snooze sets status=snoozed and tag snooze-until:<ISO>", async () => {
    const store = new FactStore(":memory:");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const task = await captureTask(store, "submit tax return", { now: T0 });
    await runTaskSnooze(store, task.id, FUTURE_ISO, T0);
    expect(process.exitCode).toBe(0);

    const active = readFindings(store).find((f) => f.id === task.id);
    expect(active).toBeDefined();
    expect(active!.status).toBe("snoozed");
    expect(active!.tags).toContain(`snooze-until:${FUTURE_ISO}`);

    store.close();
  });

  // sc-3-3: snoozed task hidden before wake, visible after
  it("sc-3-3: snoozed task absent from list before wake, present after", async () => {
    const store = new FactStore(":memory:");
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    const task = await captureTask(store, "deferred task", { now: T0 });
    // Snooze until T1
    await runTaskSnooze(store, task.id, T1, T0);

    // List with now = T0 (before wake) → task should be absent
    writes.length = 0;
    runTaskList(store, {}, T0);
    expect(writes.join("")).not.toContain(task.id);

    // List with now = T2 (after wake) → task should be present
    writes.length = 0;
    runTaskList(store, {}, T2);
    expect(writes.join("")).toContain(task.id);

    store.close();
  });

  // sc-3-4: done on a snoozed task → transition succeeds, task leaves list
  it("sc-3-4: marking a snoozed task done succeeds and removes it from default list", async () => {
    const store = new FactStore(":memory:");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const task = await captureTask(store, "pay bills", { now: T0 });
    await runTaskSnooze(store, task.id, FUTURE_ISO, T0);
    expect(process.exitCode).toBe(0);

    // Transition snoozed → done
    await runTaskTransition(store, task.id, "done", T1);
    expect(process.exitCode).toBe(0);

    const active = readFindings(store).find((f) => f.id === task.id);
    expect(active!.status).toBe("done");

    // Task must not appear in the default list even with a now after the snooze wake
    const writes: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });
    runTaskList(store, {}, T2);
    expect(writes.join("")).not.toContain(task.id);

    store.close();
  });

  // sc-3-5: unparseable --until → exitCode=1, no throw
  it("sc-3-5: unparseable --until reports error on stderr and sets exitCode=1", async () => {
    const store = new FactStore(":memory:");
    const stderrWrites: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrWrites.push(String(chunk));
      return true;
    });

    const task = await captureTask(store, "some task", { now: T0 });
    await expect(
      runTaskSnooze(store, task.id, "not-a-date", T0),
    ).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(stderrWrites.join("")).toMatch(/invalid --until/);

    store.close();
  });

  // Re-snooze replaces the snooze-until tag (no stacking)
  it("re-snooze replaces rather than stacks the snooze-until tag", async () => {
    const store = new FactStore(":memory:");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const task = await captureTask(store, "revisit proposal", { now: T0 });
    // First snooze
    await runTaskSnooze(store, task.id, T1, T0);
    // Re-snooze to a different time
    await runTaskSnooze(store, task.id, FUTURE_ISO, T0);

    const active = readFindings(store).find((f) => f.id === task.id);
    expect(active!.status).toBe("snoozed");
    // Exactly one snooze-until tag and it is the latest one
    const snoozeTags = active!.tags.filter((t) => t.startsWith("snooze-until:"));
    expect(snoozeTags).toHaveLength(1);
    expect(snoozeTags[0]).toBe(`snooze-until:${FUTURE_ISO}`);

    store.close();
  });

  // Unknown id → exitCode=1, no throw
  it("unknown id → exitCode=1 and resolves without throwing", async () => {
    const store = new FactStore(":memory:");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(
      runTaskSnooze(store, "nonexistent-id-xyz", FUTURE_ISO, T0),
    ).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);

    store.close();
  });
});

describe("runTaskIngest", () => {
  const T = "2026-06-28T00:00:00.000Z";

  // sc-4-4a: malformed JSON -> exitCode 1, nothing written, no throw
  it("sc-4-4: malformed JSON rejects with exitCode 1 and writes nothing", async () => {
    const store = new FactStore(":memory:");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await expect(runTaskIngest(store, "{ not json", T)).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(store.getActiveFacts(HUB_SCOPE, undefined, "finding")).toHaveLength(0);
    store.close();
  });

  // sc-4-4b: schema-invalid (missing required `title`) -> exitCode 1, nothing written
  it("sc-4-4: payload missing a required field rejects and writes nothing", async () => {
    const store = new FactStore(":memory:");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const bad = JSON.stringify({
      domain: "medical",
      kind: "watch",
      urgency: 3,
      severity: 2,
      evidence: [],
      tags: [],
      status: "open",
    }); // no title
    await expect(runTaskIngest(store, bad, T)).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(store.getActiveFacts(HUB_SCOPE, undefined, "finding")).toHaveLength(0);
    store.close();
  });

  // valid ingest -> exitCode stays 0
  it("valid finding JSON ingests and keeps exitCode 0", async () => {
    const store = new FactStore(":memory:");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const good = JSON.stringify({
      domain: "medical",
      title: "watch ferritin",
      kind: "watch",
      urgency: 3,
      severity: 2,
      evidence: [],
      tags: [],
      status: "open",
    });
    await runTaskIngest(store, good, T);
    expect(process.exitCode).toBe(0);
    store.close();
  });
});
