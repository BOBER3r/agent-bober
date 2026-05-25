/**
 * Unit tests for bober worktree CLI command.
 *
 * Tests the pure helper and the registerWorktreeCommand registration.
 * Since CLI action handlers wrap runInWorktree, the integration is tested
 * in orchestrator/worktree.test.ts. Here we test command registration only.
 */

import { describe, it, expect } from "vitest";
import { Command } from "commander";

import { registerWorktreeCommand } from "./worktree.js";

describe("registerWorktreeCommand", () => {
  it("registers a 'worktree' subcommand on the program", () => {
    const program = new Command();
    registerWorktreeCommand(program);
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("worktree");
  });

  it("registers a 'run' sub-subcommand under worktree", () => {
    const program = new Command();
    registerWorktreeCommand(program);
    const wtCmd = program.commands.find((c) => c.name() === "worktree");
    expect(wtCmd).toBeDefined();
    const subNames = wtCmd!.commands.map((c) => c.name());
    expect(subNames).toContain("run");
  });

  it("'run' subcommand has --allow-dirty and --keep-on-success options", () => {
    const program = new Command();
    registerWorktreeCommand(program);
    const wtCmd = program.commands.find((c) => c.name() === "worktree")!;
    const runCmd = wtCmd.commands.find((c) => c.name() === "run")!;
    const optNames = runCmd.options.map((o) => o.long);
    expect(optNames).toContain("--allow-dirty");
    expect(optNames).toContain("--keep-on-success");
  });
});
