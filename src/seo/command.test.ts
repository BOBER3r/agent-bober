/**
 * Tests for `bober seo <workflow> [target]` (spec-20260715-ultimate-seo-suite,
 * Sprint 11, sc-11-1). `parseAsync`-level tests prove the command is wired
 * end to end via an injected fake runner — mirrors
 * `security-audit.test.ts`'s Commander-wiring layer.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

import { registerSeoCommand } from "./command.js";
import type { SeoRunInput, SeoRunOutcome } from "./runner.js";
import type { SeoBuildRunInput, SeoBuildRunOutcome } from "./builder/build-runner.js";
import { createDefaultConfig } from "../config/schema.js";

let tmpRoot: string;
const originalExitCode = process.exitCode;

vi.mock("../utils/fs.js", () => ({
  findProjectRoot: vi.fn(),
}));

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-seo-cli-"));
  process.exitCode = 0;

  const { findProjectRoot } = await import("../utils/fs.js");
  vi.mocked(findProjectRoot).mockResolvedValue(tmpRoot);

  // loadConfig() throws when no config file is present — write a minimal
  // valid config so the .action() handler reaches the injected runner.
  await writeFile(
    join(tmpRoot, "bober.config.json"),
    JSON.stringify(createDefaultConfig("test-project", "brownfield")),
    "utf-8",
  );
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.clearAllMocks();
  process.exitCode = originalExitCode as number | undefined;
});

function makeProgram(
  runWorkflow?: (input: SeoRunInput) => Promise<SeoRunOutcome>,
  runBuild?: (input: SeoBuildRunInput) => Promise<SeoBuildRunOutcome>,
): Command {
  const program = new Command();
  program.exitOverride(); // prevent commander from calling process.exit()
  registerSeoCommand(
    program,
    runWorkflow || runBuild ? { runWorkflow, runBuild } : undefined,
  );
  return program;
}

describe("registerSeoCommand — Commander wiring (sc-11-1)", () => {
  it("invokes the injected runWorkflow and sets process.exitCode=0 on pass, never throws", async () => {
    const runWorkflow = vi.fn(async (): Promise<SeoRunOutcome> => ({ exitCode: 0 }));
    const program = makeProgram(runWorkflow);

    await expect(
      program.parseAsync(["node", "bober", "seo", "technical-audit", "example.com"], { from: "node" }),
    ).resolves.not.toThrow();

    expect(process.exitCode).toBe(0);
    expect(runWorkflow).toHaveBeenCalledTimes(1);
    const call = runWorkflow.mock.calls[0][0];
    expect(call.workflow).toBe("technical-audit");
    expect(call.target).toBe("example.com");
    expect(call.projectRoot).toBe(tmpRoot);
    expect(typeof call.now).toBe("string");
  });

  it("sets process.exitCode=2 when the injected runner returns exitCode 2 (blocked/fail-closed)", async () => {
    const runWorkflow = vi.fn(async (): Promise<SeoRunOutcome> => ({ exitCode: 2 }));
    const program = makeProgram(runWorkflow);

    await program.parseAsync(["node", "bober", "seo", "technical-audit"], { from: "node" });

    expect(process.exitCode).toBe(2);
  });

  it("runs without a [target] argument (optional positional)", async () => {
    const runWorkflow = vi.fn(async (): Promise<SeoRunOutcome> => ({ exitCode: 0 }));
    const program = makeProgram(runWorkflow);

    await program.parseAsync(["node", "bober", "seo", "rank-track"], { from: "node" });

    expect(runWorkflow).toHaveBeenCalledTimes(1);
    expect(runWorkflow.mock.calls[0][0].target).toBeUndefined();
  });

  it("rejects an unknown workflow with exitCode=2 and never calls the runner", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runWorkflow = vi.fn(async (): Promise<SeoRunOutcome> => ({ exitCode: 0 }));
    const program = makeProgram(runWorkflow);

    await program.parseAsync(["node", "bober", "seo", "not-a-real-workflow"], { from: "node" });

    expect(process.exitCode).toBe(2);
    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it("never throws when the injected runner itself throws — sets exitCode=2 instead", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runWorkflow = vi.fn(async (): Promise<SeoRunOutcome> => {
      throw new Error("boom");
    });
    const program = makeProgram(runWorkflow);

    await expect(
      program.parseAsync(["node", "bober", "seo", "technical-audit"], { from: "node" }),
    ).resolves.not.toThrow();

    expect(process.exitCode).toBe(2);
  });

  it("sets process.exitCode=2 (fail-closed) when loadConfig throws (no config file present)", async () => {
    // Overwrite tmpRoot with an empty dir (no bober.config.json) for this test only.
    await rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = await mkdtemp(join(tmpdir(), "bober-seo-cli-noconfig-"));
    const { findProjectRoot } = await import("../utils/fs.js");
    vi.mocked(findProjectRoot).mockResolvedValue(tmpRoot);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const runWorkflow = vi.fn(async (): Promise<SeoRunOutcome> => ({ exitCode: 0 }));
    const program = makeProgram(runWorkflow);

    await expect(
      program.parseAsync(["node", "bober", "seo", "technical-audit"], { from: "node" }),
    ).resolves.not.toThrow();

    expect(process.exitCode).toBe(2);
    expect(runWorkflow).not.toHaveBeenCalled();
  });

  it("stamps `now` once (a single ISO timestamp threaded to the runner)", async () => {
    const seen: string[] = [];
    const runWorkflow = vi.fn(async (input: SeoRunInput): Promise<SeoRunOutcome> => {
      seen.push(input.now);
      return { exitCode: 0 };
    });
    const program = makeProgram(runWorkflow);

    await program.parseAsync(["node", "bober", "seo", "technical-audit"], { from: "node" });

    expect(seen).toHaveLength(1);
    expect(() => new Date(seen[0]).toISOString()).not.toThrow();
  });
});

// ── sc-13-1/sc-13-3: `seo build <reportId>` Commander wiring ────────────

describe("registerSeoCommand — `build` subcommand wiring (sc-13-1, sc-13-3)", () => {
  it("invokes the injected runBuild and sets exitCode from it (never throws)", async () => {
    const runBuild = vi.fn(async (): Promise<SeoBuildRunOutcome> => ({ exitCode: 0 }));
    const program = makeProgram(undefined, runBuild);

    await expect(
      program.parseAsync(["node", "bober", "seo", "build", "rep-1"], { from: "node" }),
    ).resolves.not.toThrow();

    expect(runBuild).toHaveBeenCalledTimes(1);
    const call = runBuild.mock.calls[0][0];
    expect(call.reportId).toBe("rep-1");
    expect(call.projectRoot).toBe(tmpRoot);
    expect(typeof call.now).toBe("string");
    expect(() => new Date(call.now).toISOString()).not.toThrow();
    expect(process.exitCode).toBe(0);
  });

  it("sets process.exitCode=2 when the injected build runner returns exitCode 2", async () => {
    const runBuild = vi.fn(async (): Promise<SeoBuildRunOutcome> => ({ exitCode: 2 }));
    const program = makeProgram(undefined, runBuild);

    await program.parseAsync(["node", "bober", "seo", "build", "rep-1"], { from: "node" });

    expect(process.exitCode).toBe(2);
  });

  it("never throws when the injected build runner itself throws — sets exitCode=2 instead", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runBuild = vi.fn(async (): Promise<SeoBuildRunOutcome> => {
      throw new Error("boom");
    });
    const program = makeProgram(undefined, runBuild);

    await expect(
      program.parseAsync(["node", "bober", "seo", "build", "rep-1"], { from: "node" }),
    ).resolves.not.toThrow();

    expect(process.exitCode).toBe(2);
  });

  it("sets process.exitCode=2 (fail-closed) when loadConfig throws (no config file present)", async () => {
    await rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = await mkdtemp(join(tmpdir(), "bober-seo-cli-build-noconfig-"));
    const { findProjectRoot } = await import("../utils/fs.js");
    vi.mocked(findProjectRoot).mockResolvedValue(tmpRoot);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const runBuild = vi.fn(async (): Promise<SeoBuildRunOutcome> => ({ exitCode: 0 }));
    const program = makeProgram(undefined, runBuild);

    await expect(
      program.parseAsync(["node", "bober", "seo", "build", "rep-1"], { from: "node" }),
    ).resolves.not.toThrow();

    expect(process.exitCode).toBe(2);
    expect(runBuild).not.toHaveBeenCalled();
  });

  it("does not invoke runBuild when the analyze workflow command is used instead (additive, no cross-talk)", async () => {
    const runWorkflow = vi.fn(async (): Promise<SeoRunOutcome> => ({ exitCode: 0 }));
    const runBuild = vi.fn(async (): Promise<SeoBuildRunOutcome> => ({ exitCode: 0 }));
    const program = makeProgram(runWorkflow, runBuild);

    await program.parseAsync(["node", "bober", "seo", "technical-audit", "example.com"], {
      from: "node",
    });

    expect(runWorkflow).toHaveBeenCalledTimes(1);
    expect(runBuild).not.toHaveBeenCalled();
  });

  it("still routes an unrecognized workflow name to the analyze action, not build (sc-13-3)", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const runWorkflow = vi.fn(async (): Promise<SeoRunOutcome> => ({ exitCode: 0 }));
    const runBuild = vi.fn(async (): Promise<SeoBuildRunOutcome> => ({ exitCode: 0 }));
    const program = makeProgram(runWorkflow, runBuild);

    await program.parseAsync(["node", "bober", "seo", "not-a-real-workflow"], { from: "node" });

    expect(process.exitCode).toBe(2); // unknown-workflow guard in the analyze action
    expect(runBuild).not.toHaveBeenCalled();
  });
});
