import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FactStore } from "../../state/facts.js";
import { runTaskAdd } from "./task.js";

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
