import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FactStore } from "../../state/facts.js";
import { runTaskAdd, runTaskList, runTaskTransition } from "./task.js";
import { captureTask } from "../../hub/task-inbox.js";
import { readFindings } from "../../hub/finding-store.js";

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
    runTaskList(store, {});
    const output = writes.join("");
    // task2 (still open) is shown
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
    runTaskList(store, { all: true });
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

    runTaskList(store, {});
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
