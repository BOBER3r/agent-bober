import { Buffer } from "node:buffer";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createScratchStore } from "./scratch.js";
import type { ScratchStore } from "./scratch.js";
import { createTraceWriter, readSpans } from "./trace.js";
import type { TraceWriter } from "./trace.js";
import {
  DEFAULT_DENY_BINARIES,
  createSandboxPolicy,
  createSandboxRunner,
  sandboxEnvFromProcess,
} from "./sandbox.js";
import type { SandboxOutcome, SandboxPolicy } from "./sandbox.js";

/**
 * sc-6-9 — the command sandbox.
 *
 * Every test here spawns (or refuses to spawn) a REAL process. The timeout test in
 * particular runs a genuinely non-terminating child and asserts the runner kills it: a
 * fake clock would prove the timer fires, which is the easy half, and prove nothing at
 * all about the kill path, which is the half that hangs a pipeline.
 *
 * `process.execPath` is the binary under test throughout — it is guaranteed present,
 * takes `-e` for an inline program, and needs no fixture files.
 */

let root = "";
let scratch: ScratchStore;
let trace: TraceWriter;
const RUN = "run-20260805-d";
const NODE = "node";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-sandbox-"));
  scratch = createScratchStore(root);
  trace = await createTraceWriter(root, RUN);
});

afterEach(async () => {
  await trace.close().catch(() => undefined);
  await rm(root, { recursive: true, force: true });
});

/** A policy that allows only the node binary, inside the temp root. */
function policyAllowingNode(over: Partial<SandboxPolicy> = {}): SandboxPolicy {
  return {
    ...createSandboxPolicy({
      cwd: root,
      allowBinaries: [NODE],
      timeoutMs: 10_000,
      maxOutputBytes: 64 * 1024,
      env: sandboxEnvFromProcess(),
    }),
    ...over,
  };
}

async function spans(): Promise<Awaited<ReturnType<typeof readSpans>>> {
  await trace.close();
  return readSpans(trace.path());
}

describe("SandboxRunner — allowed commands", () => {
  it("runs an allowlisted binary and offloads stdout and stderr to scratch", async () => {
    const runner = createSandboxRunner(root, RUN, trace);
    const outcome = await runner.run(
      process.execPath,
      ["-e", "process.stdout.write('hello out'); process.stderr.write('hello err')"],
      policyAllowingNode(),
      scratch,
    );

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(outcome.exitCode).toBe(0);
    expect(await scratch.text(outcome.stdoutRef)).toBe("hello out");
    expect(await scratch.text(outcome.stderrRef)).toBe("hello err");
    expect(outcome.stdoutRef.kind).toBe("stdout");
    expect(outcome.stderrRef.kind).toBe("stderr");

    const [span] = await spans();
    expect(span?.status).toBe("ok");
    expect(span?.nodeId).toBe("sandbox");
    expect(span?.kind).toBe("tool");
    expect(span?.toolOutputRef).toEqual(outcome.stdoutRef);
  });

  it("reports a non-zero exit code without throwing", async () => {
    const runner = createSandboxRunner(root, RUN, trace);
    const outcome = await runner.run(
      process.execPath,
      ["-e", "process.exitCode = 3"],
      policyAllowingNode(),
      scratch,
    );
    expect(outcome).toMatchObject({ status: "ok", exitCode: 3 });

    const [span] = await spans();
    expect(span?.status).toBe("failed");
    expect(span?.errorClass).toBe("SandboxExit:3");
  });

  it("runs in the policy's cwd, not the process cwd", async () => {
    const runner = createSandboxRunner(root, RUN, trace);
    const outcome = await runner.run(
      process.execPath,
      ["-e", "process.stdout.write(process.cwd())"],
      policyAllowingNode(),
      scratch,
    );
    if (outcome.status !== "ok") throw new Error(`expected ok, got ${outcome.status}`);
    // macOS reports the realpath of a temp dir; compare on the trailing segment.
    expect((await scratch.text(outcome.stdoutRef)).endsWith(root.split("/").at(-1) ?? "")).toBe(
      true,
    );
  });

  it("passes ONLY the policy env — the parent's variables do not leak", async () => {
    process.env.BOBER_SANDBOX_LEAK_PROBE = "leaked";
    try {
      const runner = createSandboxRunner(root, RUN, trace);
      const outcome = await runner.run(
        process.execPath,
        ["-e", "process.stdout.write(String(process.env.BOBER_SANDBOX_LEAK_PROBE ?? 'absent'))"],
        policyAllowingNode(),
        scratch,
      );
      if (outcome.status !== "ok") throw new Error(`expected ok, got ${outcome.status}`);
      expect(await scratch.text(outcome.stdoutRef)).toBe("absent");
    } finally {
      delete process.env.BOBER_SANDBOX_LEAK_PROBE;
    }

    // ...and a variable the policy DOES declare is visible, so the probe is live.
    const runner = createSandboxRunner(root, RUN, trace);
    const outcome = await runner.run(
      process.execPath,
      ["-e", "process.stdout.write(String(process.env.DECLARED ?? 'absent'))"],
      policyAllowingNode({ env: { ...sandboxEnvFromProcess(), DECLARED: "yes" } }),
      scratch,
    );
    if (outcome.status !== "ok") throw new Error(`expected ok, got ${outcome.status}`);
    expect(await scratch.text(outcome.stdoutRef)).toBe("yes");
  });

  it("never runs a shell: metacharacters stay one literal argument", async () => {
    const runner = createSandboxRunner(root, RUN, trace);
    const outcome = await runner.run(
      process.execPath,
      ["-e", "process.stdout.write(process.argv[1] ?? '')", "; rm -rf / && echo pwned"],
      policyAllowingNode(),
      scratch,
    );
    if (outcome.status !== "ok") throw new Error(`expected ok, got ${outcome.status}`);
    expect(await scratch.text(outcome.stdoutRef)).toBe("; rm -rf / && echo pwned");
  });
});

describe("SandboxRunner — denial happens BEFORE spawn (sc-6-9)", () => {
  it("returns status 'denied' naming the binary and never executes it", async () => {
    const runner = createSandboxRunner(root, RUN, trace);
    const marker = join(root, "side-effect.txt");

    // The command would create a file if it ran. It must not run.
    const outcome = await runner.run(
      process.execPath,
      ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`],
      policyAllowingNode({ allowBinaries: ["tsc"] }),
      scratch,
    );

    expect(outcome).toEqual({
      status: "denied",
      binary: "node",
      reason: "not-allowlisted",
    });
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(root)).not.toContain("side-effect.txt");
  });

  it("denies a denylisted binary even when the allowlist names it", async () => {
    const runner = createSandboxRunner(root, RUN, trace);
    const outcome = await runner.run(
      "sh",
      ["-c", "echo pwned"],
      policyAllowingNode({ allowBinaries: ["sh", NODE], denyBinaries: ["sh"] }),
      scratch,
    );
    expect(outcome).toEqual({ status: "denied", binary: "sh", reason: "denylisted" });
  });

  it("denies every shell and network client in the default denylist", async () => {
    const runner = createSandboxRunner(root, RUN, trace);
    expect(DEFAULT_DENY_BINARIES).toContain("sh");
    expect(DEFAULT_DENY_BINARIES).toContain("bash");
    expect(DEFAULT_DENY_BINARIES).toContain("curl");
    expect(DEFAULT_DENY_BINARIES).toContain("sudo");

    for (const binary of ["sh", "bash", "curl", "sudo"]) {
      const outcome = await runner.run(
        binary,
        [],
        policyAllowingNode({ allowBinaries: [binary] }),
        scratch,
      );
      expect(outcome, binary).toMatchObject({ status: "denied", reason: "denylisted" });
    }
  });

  it("compares by basename, so an absolute path cannot smuggle a denied binary in", async () => {
    const runner = createSandboxRunner(root, RUN, trace);
    const outcome = await runner.run(
      "/bin/sh",
      ["-c", "echo pwned"],
      policyAllowingNode({ allowBinaries: ["/bin/sh"] }),
      scratch,
    );
    expect(outcome).toEqual({ status: "denied", binary: "sh", reason: "denylisted" });
  });

  it("denies a cwd outside the project root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "bober-pge-outside-"));
    try {
      const runner = createSandboxRunner(root, RUN, trace);
      const outcome = await runner.run(
        process.execPath,
        ["-e", "process.stdout.write('ran')"],
        policyAllowingNode({ cwd: outside }),
        scratch,
      );
      expect(outcome).toEqual({ status: "denied", binary: "node", reason: "cwd-escape" });

      const escaping = await runner.run(
        process.execPath,
        ["-e", "process.stdout.write('ran')"],
        policyAllowingNode({ cwd: join(root, "..", "..") }),
        scratch,
      );
      expect(escaping).toMatchObject({ status: "denied", reason: "cwd-escape" });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("an empty allowlist permits nothing", async () => {
    const runner = createSandboxRunner(root, RUN, trace);
    const outcome = await runner.run(
      process.execPath,
      ["-e", "0"],
      policyAllowingNode({ allowBinaries: [] }),
      scratch,
    );
    expect(outcome).toMatchObject({ status: "denied", reason: "not-allowlisted" });
  });

  it("records every denial as a span and writes no scratch payload", async () => {
    const runner = createSandboxRunner(root, RUN, trace);
    await runner.run(process.execPath, ["-e", "0"], policyAllowingNode({ allowBinaries: [] }), scratch);
    await runner.run("sh", [], policyAllowingNode({ allowBinaries: ["sh"] }), scratch);

    const recorded = await spans();
    expect(recorded.length).toBe(2);
    expect(recorded.map((s) => s.errorClass)).toEqual([
      "SandboxDenied:not-allowlisted",
      "SandboxDenied:denylisted",
    ]);
    expect(recorded.every((s) => s.status === "failed")).toBe(true);
    await expect(readdir(join(root, ".bober", "scratch"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("SandboxRunner — timeout kills a real process (sc-6-9)", () => {
  it("returns status 'timeout' instead of hanging, and the child does not outlive it", async () => {
    const runner = createSandboxRunner(root, RUN, trace);
    const started = Date.now();

    // A genuinely non-terminating child: an interval that is never cleared, plus an
    // ignored SIGTERM so only the SIGKILL escalation can end it.
    const outcome: SandboxOutcome = await runner.run(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.stdout.write('alive')",
      ],
      policyAllowingNode({ timeoutMs: 400 }),
      scratch,
    );
    const elapsed = Date.now() - started;

    expect(outcome).toEqual({ status: "timeout", timeoutMs: 400 });
    // Resolved promptly: the timer plus the SIGKILL grace period, not the child's own
    // lifetime (which is unbounded).
    expect(elapsed).toBeLessThan(8_000);

    const [span] = await spans();
    expect(span?.status).toBe("failed");
    expect(span?.errorClass).toBe("SandboxTimeout");
  }, 20_000);

  it("a command that finishes inside the bound is not reported as a timeout", async () => {
    const runner = createSandboxRunner(root, RUN, trace);
    const outcome = await runner.run(
      process.execPath,
      ["-e", "setTimeout(() => process.stdout.write('done'), 50)"],
      policyAllowingNode({ timeoutMs: 5_000 }),
      scratch,
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect(await scratch.text(outcome.stdoutRef)).toBe("done");
  }, 20_000);
});

describe("SandboxRunner — output truncation (sc-6-9)", () => {
  it("returns status 'output-truncated' beyond maxOutputBytes and keeps the prefix", async () => {
    const runner = createSandboxRunner(root, RUN, trace);
    const outcome = await runner.run(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(50000))"],
      policyAllowingNode({ maxOutputBytes: 1_000 }),
      scratch,
    );

    expect(outcome.status).toBe("output-truncated");
    if (outcome.status !== "output-truncated") throw new Error("unreachable");
    expect(outcome.limit).toBe(1_000);
    expect(outcome.bytes).toBeGreaterThan(1_000);

    const kept = await scratch.get(outcome.stdoutRef);
    expect(kept.byteLength).toBe(1_000);
    expect(kept.equals(Buffer.alloc(1_000, "x"))).toBe(true);

    const [span] = await spans();
    expect(span?.status).toBe("failed");
    expect(span?.errorClass).toBe("SandboxOutputTruncated");
    expect(span?.toolOutputRef).toEqual(outcome.stdoutRef);
  }, 20_000);

  it("output exactly at the limit is NOT truncated", async () => {
    const runner = createSandboxRunner(root, RUN, trace);
    const outcome = await runner.run(
      process.execPath,
      ["-e", "process.stdout.write('y'.repeat(1000))"],
      policyAllowingNode({ maxOutputBytes: 1_000 }),
      scratch,
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") throw new Error("unreachable");
    expect((await scratch.get(outcome.stdoutRef)).byteLength).toBe(1_000);
  }, 20_000);
});

describe("SandboxRunner — never throws (sc-6-9)", () => {
  it("all three failure modes resolve rather than reject", async () => {
    const runner = createSandboxRunner(root, RUN, trace);
    const results = await Promise.allSettled([
      runner.run(process.execPath, ["-e", "0"], policyAllowingNode({ allowBinaries: [] }), scratch),
      runner.run(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        policyAllowingNode({ timeoutMs: 300 }),
        scratch,
      ),
      runner.run(
        process.execPath,
        ["-e", "process.stdout.write('z'.repeat(5000))"],
        policyAllowingNode({ maxOutputBytes: 100 }),
        scratch,
      ),
    ]);

    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    const statuses = results.map((r) =>
      r.status === "fulfilled" ? (r.value as SandboxOutcome).status : "REJECTED",
    );
    expect(statuses.sort()).toEqual(["denied", "output-truncated", "timeout"]);

    // Every one of them left a span behind.
    expect((await spans()).length).toBe(3);
  }, 20_000);

  it("createSandboxPolicy fills in the safe defaults and declares no network", () => {
    const policy = createSandboxPolicy({ cwd: root, allowBinaries: ["tsc"] });
    expect(policy.network).toBe(false);
    expect(policy.denyBinaries).toEqual([...DEFAULT_DENY_BINARIES]);
    expect(policy.timeoutMs).toBe(120_000);
    expect(policy.maxOutputBytes).toBe(1_000_000);
    expect(Object.keys(policy.env)).toEqual(["PATH"]);
  });

  it("sandboxEnvFromProcess copies only the named variables", () => {
    process.env.BOBER_SANDBOX_ENV_PROBE = "value";
    try {
      expect(sandboxEnvFromProcess(["BOBER_SANDBOX_ENV_PROBE"])).toEqual({
        BOBER_SANDBOX_ENV_PROBE: "value",
      });
      expect(sandboxEnvFromProcess(["BOBER_ABSENT_VARIABLE"])).toEqual({});
      expect(sandboxEnvFromProcess([])).toEqual({});
    } finally {
      delete process.env.BOBER_SANDBOX_ENV_PROBE;
    }
  });
});
