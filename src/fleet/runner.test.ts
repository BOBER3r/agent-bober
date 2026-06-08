import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ChildRunner, resolveCliEntry, probeCliVersion } from "./runner.js";

// ── Helpers ──────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const stub = join(__dirname, "__fixtures__", "stub-child.js");

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-runner-"));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── resolveCliEntry and probeCliVersion (sc-2-9) ─────────────────────

describe("resolveCliEntry()", () => {
  it("resolves to cli/index.js relative to the module (ADR-4 — not a bare PATH lookup) (sc-2-9)", () => {
    const entry = resolveCliEntry();
    // At runtime (dist/): dist/cli/index.js
    // During vitest (src/): src/cli/index.js
    // Either way: ends with cli/index.js and is an absolute path (uses fileURLToPath, not a bare PATH name)
    expect(entry).toMatch(/cli[/\\]index\.js$/);
    expect(entry).toMatch(/^\//); // absolute path (Unix)
  });
});

describe("probeCliVersion()", () => {
  it("returns true for the stub fixture when called with --version argv (sc-2-9)", async () => {
    const ok = await probeCliVersion(stub);
    expect(ok).toBe(true);
  });

  it("returns false for a non-existent entry (sc-2-9)", async () => {
    const ok = await probeCliVersion("/nonexistent/path/to/cli/index.js");
    expect(ok).toBe(false);
  });
});

// ── ChildRunner.run() — success path (sc-2-7) ────────────────────────
// run() calls: process.execPath [cliEntry, 'run', task]
// For an exit-0 test we use a fixture that exits 0 unconditionally.

describe("ChildRunner.run() — success exit 0 (sc-2-7)", () => {
  it("returns ChildSpawnResult with exitCode 0 when cliEntry exits 0", async () => {
    // A minimal fixture that always exits 0 regardless of argv
    const alwaysOk = join(tmpDir, "always-ok.js");
    await writeFile(alwaysOk, "process.exit(0);\n", "utf8");

    const runner = new ChildRunner({ cliEntry: alwaysOk });
    const result = await runner.run({ cwd: tmpDir, task: "anything" });

    expect(result.cwd).toBe(tmpDir);
    expect(result.exitCode).toBe(0);
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
    expect(result.timedOut).toBeFalsy();
    expect(result.spawnError).toBeUndefined();
  });
});

// ── ChildRunner.run() — non-zero exit (sc-2-7) ───────────────────────

describe("ChildRunner.run() — non-zero exit (sc-2-7)", () => {
  it("returns exitCode 3 when cliEntry exits with code 3", async () => {
    // Fixture that always exits 3
    const exit3 = join(tmpDir, "exit-3.js");
    await writeFile(exit3, "process.exit(3);\n", "utf8");

    const runner = new ChildRunner({ cliEntry: exit3 });
    const result = await runner.run({ cwd: tmpDir, task: "sometask" });

    expect(result.cwd).toBe(tmpDir);
    expect(result.exitCode).toBe(3);
    expect(result.spawnError).toBeUndefined();
    // run() must not throw — we reached this line
  });
});

// ── ChildRunner.run() — spawn failure (sc-2-7) ───────────────────────
// Inject a nonexistent binary path via nodeBin to trigger an ENOENT spawn error.

describe("ChildRunner.run() — spawn failure capture (sc-2-7)", () => {
  it("captures ENOENT in spawnError and returns null exitCode without throwing", async () => {
    const runner = new ChildRunner({
      cliEntry: stub,
      nodeBin: "/nonexistent/node-binary",
    });
    const result = await runner.run({ cwd: tmpDir, task: "sometask" });

    expect(result.cwd).toBe(tmpDir);
    expect(result.exitCode).toBeNull();
    expect(result.spawnError).toBeDefined();
    expect(typeof result.spawnError).toBe("string");
    expect((result.spawnError as string).length).toBeGreaterThan(0);
    // ENOENT or similar spawn error in message
    expect(result.spawnError).toMatch(/ENOENT|spawn|not found/i);
    // run() must not throw — we reached this line
  });
});

// ── ChildRunner.run() — timeout behavior (sc-2-8) ────────────────────

describe("ChildRunner.run() — timeout (sc-2-8)", () => {
  it("returns timedOut true when cliEntry sleeps beyond timeoutMs (sc-2-8)", async () => {
    // Fixture that sleeps 10 seconds — will be killed by 100 ms timeout
    const sleeper = join(tmpDir, "sleeper.js");
    await writeFile(sleeper, "setTimeout(() => process.exit(0), 10000);\n", "utf8");

    const runner = new ChildRunner({ cliEntry: sleeper });
    const result = await runner.run({ cwd: tmpDir, task: "any", timeoutMs: 100 });

    expect(result.timedOut).toBe(true);
    expect(result.cwd).toBe(tmpDir);
  }, 10_000);

  it("fast cliEntry completes without timedOut when no timeoutMs is provided (DEFAULT_TIMEOUT_MS used) (sc-2-8)", async () => {
    // A fast-exit fixture; omitting timeoutMs exercises the DEFAULT_TIMEOUT_MS path
    const alwaysOk = join(tmpDir, "always-ok2.js");
    await writeFile(alwaysOk, "process.exit(0);\n", "utf8");

    const runner = new ChildRunner({ cliEntry: alwaysOk });
    const result = await runner.run({ cwd: tmpDir, task: "any" }); // no timeoutMs

    expect(result.timedOut).toBeFalsy();
    expect(result.exitCode).toBe(0);
  });
});
