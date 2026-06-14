import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDefaultConfig } from "../../config/schema.js";
import { runUpdateCommand } from "./update.js";

// runUpdateCommand resolves the package root relative to this module, so under
// vitest it reads the real skills/ + agents/ at the repo root. These tests
// therefore exercise the actual install path against a throwaway project dir.

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bober-update-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe("runUpdateCommand", () => {
  it("refreshes .claude/commands and .claude/agents from the package", async () => {
    const cfg = createDefaultConfig("test-proj", "greenfield");
    await writeFile(
      join(dir, "bober.config.json"),
      JSON.stringify(cfg, null, 2),
      "utf-8",
    );

    await runUpdateCommand(dir);

    // A universal slash command was installed.
    expect(await exists(join(dir, ".claude/commands/bober-plan.md"))).toBe(true);
    // The agents added in 0.17.0 are present (documenter + incident agents).
    expect(await exists(join(dir, ".claude/agents/bober-documenter.md"))).toBe(
      true,
    );
    expect(await exists(join(dir, ".claude/agents/bober-diagnoser.md"))).toBe(
      true,
    );
    expect(await exists(join(dir, ".claude/agents/bober-postmortemer.md"))).toBe(
      true,
    );
  });

  it("never modifies bober.config.json or creates .bober/ state", async () => {
    const cfg = createDefaultConfig("test-proj", "greenfield");
    const original = JSON.stringify(cfg, null, 2);
    await writeFile(join(dir, "bober.config.json"), original, "utf-8");

    await runUpdateCommand(dir);

    const after = await readFile(join(dir, "bober.config.json"), "utf-8");
    expect(after).toBe(original);
    // update is purely a .claude/ refresh — it must not scaffold .bober/.
    expect(await exists(join(dir, ".bober"))).toBe(false);
  });

  it("fails with exit code 1 when there is no bober.config.json", async () => {
    const prev = process.exitCode;
    process.exitCode = 0;

    await runUpdateCommand(dir); // empty dir, no config

    expect(process.exitCode).toBe(1);
    // Nothing should have been written.
    expect(await exists(join(dir, ".claude"))).toBe(false);

    process.exitCode = prev; // restore so a single failing case can't fail the run
  });
});
