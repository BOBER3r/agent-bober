import { Buffer } from "node:buffer";
import { basename } from "node:path";
import { execa } from "execa";

import type { NodeKind } from "../../contracts/topology.js";
import type { Phase } from "../../state/history.js";
import type { ScratchRef } from "../state/overall.js";
import { resolveWithin } from "./scratch.js";
import type { ScratchStore } from "./scratch.js";
import type { TraceWriter } from "./trace.js";

/**
 * The command sandbox: an allowlist, a working-directory confinement and a wall clock.
 *
 * ── What this is NOT ──
 *
 * There is no container here, no seccomp filter, no namespace and no network namespace.
 * A generated test that this runner executes CAN still read any file under its `cwd`,
 * and — if the caller allowlists a binary with network capability — can still reach the
 * network. `policy.network: false` is a DECLARATION that the policy intends no network
 * access, enforced by which binaries the allowlist contains, not by the kernel. Anyone
 * reading this module for an isolation guarantee should stop here: the guarantee is
 * "only these binaries, only under this directory, only for this long", and nothing more.
 *
 * ── Entirely net-new ──
 *
 * Nothing in the shipped tool layer can be reused. `src/orchestrator/tools/handlers.ts`
 * executes `execa("sh", ["-c", command])` with no guard at all, and the `redis-cli` entry
 * at `src/orchestrator/environment.ts:38` is a PATH probe inside `CANDIDATE_TOOLS`, not a
 * blocklist. This module does not touch either of them — retrofitting the live agent tool
 * path would change agent behaviour and is separate work.
 *
 * ── Three things that must not happen ──
 *
 *  1. A denied command must not SPAWN. The allow/deny/cwd checks run before `execa` is
 *     reached, so a denied binary has no opportunity to have a side effect. The test
 *     proves this by denying a command that would have written a marker file.
 *  2. A non-terminating command must not hang the run. A timer aborts the subprocess and
 *     `forceKillAfterDelay` escalates to SIGKILL, so `run` resolves in `timeoutMs` plus
 *     the kill grace period, whatever the child does.
 *  3. None of the three failure modes may THROW. Denial, timeout and truncation are
 *     ordinary outcomes of a `SandboxOutcome` union, each recorded as a span, because a
 *     gate node routes on them — it does not catch them.
 *
 * ── No shell, ever ──
 *
 * `execa(file, argv)` with an explicit argument array. No `sh -c`, no string command, so
 * argument content cannot become syntax: `rm -rf /` arriving as ONE argument to an
 * allowlisted binary is a nonsense filename, not a command.
 */

// ── Policy ──────────────────────────────────────────────────────────

export interface SandboxPolicy {
  /** Binaries that may run, compared by basename. Empty means nothing may run. */
  allowBinaries: readonly string[];
  /** Checked FIRST and independently of the allowlist — defence in depth. */
  denyBinaries: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
  /** Must resolve inside the runner's `projectRoot`. */
  cwd: string;
  /** The COMPLETE environment of the child. `process.env` is not inherited. */
  env: Record<string, string>;
  network: false;
}

/**
 * Denied by default, whether or not a caller remembered to allowlist carefully.
 *
 * Shells and `env` are here because they re-open arbitrary execution behind an
 * allowlisted name; the network clients because `network: false` would otherwise be
 * decorative; `sudo` because it discards every other bound in this list.
 */
export const DEFAULT_DENY_BINARIES: readonly string[] = Object.freeze([
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "env",
  "sudo",
  "doas",
  "su",
  "curl",
  "wget",
  "nc",
  "ncat",
  "netcat",
  "ssh",
  "scp",
  "telnet",
  "docker",
  "podman",
  "kubectl",
]);

/**
 * The environment variables a child inherits, by explicit name.
 *
 * `PATH` is the default because an allowlisted bare binary name cannot otherwise be
 * resolved. Everything else — API keys above all — stays in the parent process, which
 * `sandbox.test.ts` asserts by probing for a variable it sets on `process.env` itself.
 */
export function sandboxEnvFromProcess(
  names: readonly string[] = ["PATH"],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** A policy with the safe defaults filled in. `allowBinaries` has no default on purpose. */
export function createSandboxPolicy(args: {
  cwd: string;
  allowBinaries: readonly string[];
  denyBinaries?: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
}): SandboxPolicy {
  return {
    allowBinaries: [...args.allowBinaries],
    denyBinaries: [...(args.denyBinaries ?? DEFAULT_DENY_BINARIES)],
    timeoutMs: args.timeoutMs ?? 120_000,
    maxOutputBytes: args.maxOutputBytes ?? 1_000_000,
    cwd: args.cwd,
    env: args.env ?? sandboxEnvFromProcess(),
    network: false,
  };
}

// ── Outcome ─────────────────────────────────────────────────────────

export const SANDBOX_DENY_REASONS = ["denylisted", "not-allowlisted", "cwd-escape"] as const;
export type SandboxDenyReason = (typeof SANDBOX_DENY_REASONS)[number];

export type SandboxOutcome =
  | { status: "ok"; exitCode: number; stdoutRef: ScratchRef; stderrRef: ScratchRef }
  | { status: "denied"; binary: string; reason: SandboxDenyReason }
  | { status: "timeout"; timeoutMs: number }
  | { status: "output-truncated"; stdoutRef: ScratchRef; bytes: number; limit: number };

/** Optional span attribution; the runner records a span for every outcome regardless. */
export interface SandboxSpanInfo {
  nodeId?: string;
  kind?: NodeKind;
  phase?: Phase;
  branchKey?: string | null;
  parentSpanId?: string | null;
  superstep?: number;
}

export interface SandboxRunner {
  run(
    cmd: string,
    args: readonly string[],
    policy: SandboxPolicy,
    scratch: ScratchStore,
    span?: SandboxSpanInfo,
  ): Promise<SandboxOutcome>;
}

/** How long after SIGTERM the runner escalates to SIGKILL. */
export const SANDBOX_FORCE_KILL_AFTER_MS = 500;

// ── Runner ──────────────────────────────────────────────────────────

/**
 * A sandbox runner bound to one project root, one run and one trace.
 *
 * @param projectRoot REQUIRED. Every policy's `cwd` must resolve inside it; a `cwd`
 *   anywhere else is denied with `"cwd-escape"` rather than confined silently.
 * @param runId the run whose scratch namespace captured output is written to.
 * @param trace every outcome — including the three failure modes — is recorded here.
 */
export function createSandboxRunner(
  projectRoot: string,
  runId: string,
  trace: TraceWriter,
): SandboxRunner {
  return {
    async run(cmd, args, policy, scratch, span = {}): Promise<SandboxOutcome> {
      const handle = trace.begin({
        nodeId: span.nodeId ?? "sandbox",
        kind: span.kind ?? "tool",
        phase: span.phase ?? "generating",
        branchKey: span.branchKey ?? null,
        parentSpanId: span.parentSpanId ?? null,
        superstep: span.superstep ?? 0,
      });

      // ── Pre-spawn gates ──
      // Order matters and is asserted: deny beats allow, and both are decided before a
      // process could exist.
      const binary = basename(cmd);

      const denied = (reason: SandboxDenyReason): SandboxOutcome => {
        handle.end({ status: "failed", errorClass: `SandboxDenied:${reason}` });
        return { status: "denied", binary, reason };
      };

      // The default denylist is a property of the RUNNER, not of whatever policy object a
      // caller happened to construct: `createSandboxPolicy` merely DEFAULTS `denyBinaries`
      // to it, and a caller is free to pass `denyBinaries: []` (one already does). Checking
      // it unconditionally, before the caller's list and before the allowlist, means a
      // shell, an escalator or a network fetcher cannot be reached by handing the runner a
      // permissive policy. A caller may only ever deny MORE than this, never less.
      if (DEFAULT_DENY_BINARIES.includes(binary)) return denied("denylisted");
      if (policy.denyBinaries.includes(binary)) return denied("denylisted");
      if (!policy.allowBinaries.includes(binary)) return denied("not-allowlisted");
      const cwd = resolveWithin(projectRoot, policy.cwd);
      if (cwd === null) return denied("cwd-escape");

      // ── Spawn ──
      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, policy.timeoutMs);

      let stdout: string;
      let stderr: string;
      let exitCode: number;
      let overBuffer: boolean;

      try {
        const result = await execa(cmd, [...args], {
          cwd,
          env: { ...policy.env },
          extendEnv: false,
          reject: false,
          cancelSignal: controller.signal,
          forceKillAfterDelay: SANDBOX_FORCE_KILL_AFTER_MS,
          // One buffer bound above the policy's own, so a runaway writer is stopped by
          // execa even before the truncation check reads the string.
          maxBuffer: Math.max(policy.maxOutputBytes * 2, 1024),
          stripFinalNewline: false,
        });
        stdout = typeof result.stdout === "string" ? result.stdout : "";
        stderr = typeof result.stderr === "string" ? result.stderr : "";
        exitCode = result.exitCode ?? -1;
        overBuffer = result.isMaxBuffer;
        if (result.isCanceled || result.timedOut) timedOut = true;
      } finally {
        clearTimeout(timer);
      }

      if (timedOut) {
        handle.end({ status: "failed", errorClass: "SandboxTimeout" });
        return { status: "timeout", timeoutMs: policy.timeoutMs };
      }

      const stdoutBytes = Buffer.byteLength(stdout, "utf8");
      if (overBuffer || stdoutBytes > policy.maxOutputBytes) {
        // The captured prefix is preserved rather than discarded: a truncated log is
        // still the most useful artifact a failed generated test leaves behind.
        const kept = Buffer.from(stdout, "utf8").subarray(0, policy.maxOutputBytes);
        const stdoutRef = await scratch.put(runId, "stdout", kept);
        handle.end({
          status: "failed",
          errorClass: "SandboxOutputTruncated",
          toolOutputRef: stdoutRef,
        });
        return {
          status: "output-truncated",
          stdoutRef,
          bytes: stdoutBytes,
          limit: policy.maxOutputBytes,
        };
      }

      const stdoutRef = await scratch.put(runId, "stdout", stdout);
      const stderrRef = await scratch.put(runId, "stderr", stderr);
      handle.end({
        status: exitCode === 0 ? "ok" : "failed",
        errorClass: exitCode === 0 ? undefined : `SandboxExit:${exitCode}`,
        toolOutputRef: stdoutRef,
      });
      return { status: "ok", exitCode, stdoutRef, stderrRef };
    },
  };
}
