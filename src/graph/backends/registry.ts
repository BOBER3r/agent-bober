/**
 * Graph backend registry + resolver.
 *
 * `resolveGraphBackend()` decides which GraphBackend implementation the
 * caller should use:
 *   1. An explicit `config.graph.backend` value WINS — no probe of the other
 *      backend, no fallback if that backend's binary turns out to be missing
 *      (the caller's own prereq check surfaces that with the SAME backend's
 *      install hint, not a combined one).
 *   2. Otherwise, auto-detect by probing each known backend's version
 *      command (in `KNOWN_BACKENDS` order — tokensave first, so tokensave
 *      wins when both are installed).
 *   3. If neither is installed, throw a structured error whose hint
 *      concatenates BOTH backends' install hints.
 *
 * The probe is injectable so tests never need a real binary on PATH.
 */

import { execa } from "execa";
import type { BoberConfig } from "../../config/schema.js";
import type { GraphBackend, ProcessSpec } from "./types.js";
import { TokensaveBackend } from "./tokensave-backend.js";
import { CodeReviewGraphBackend } from "./code-review-graph-backend.js";

// ── Registry ─────────────────────────────────────────────────────────

/** Known backends, in preference order (tokensave first). */
export const KNOWN_BACKENDS: readonly GraphBackend[] = [
  new TokensaveBackend(),
  new CodeReviewGraphBackend(),
];

// ── Version probe ────────────────────────────────────────────────────

/** Injectable detection probe: "did `<binary> <args>` run and print a parseable version?" */
export type VersionProbe = (
  binary: string,
  args: string[],
) => Promise<{ ok: boolean; version?: string }>;

/**
 * Default probe: run `<binary> <args>` and treat exit 0 + a parseable semver
 * in stdout as "installed". This is detection only — NOT the compatibility
 * gate (that stays in the per-site GenericPrereqCheck, which also applies
 * `PrereqSpec.isCompatible`).
 */
async function defaultProbe(
  binary: string,
  args: string[],
): Promise<{ ok: boolean; version?: string }> {
  try {
    const result = await execa(binary, args, { reject: false, timeout: 5000 });
    if (result.exitCode !== 0 || result.failed) return { ok: false };
    const firstLine = (result.stdout ?? "").split("\n")[0] ?? "";
    const match = /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(firstLine);
    if (!match) return { ok: false };
    return { ok: true, version: match[1] };
  } catch {
    return { ok: false };
  }
}

// ── Binary path resolution ──────────────────────────────────────────

/**
 * The binary to invoke for a given backend, honoring a per-backend path
 * override in config (tokensavePath / codeReviewGraphPath), falling back to
 * the backend's own default binary name.
 */
export function binaryForBackend(
  backend: GraphBackend,
  config: BoberConfig,
): string {
  const graph = config.graph;
  if (backend.id === "tokensave") {
    return graph?.tokensavePath ?? backend.processSpec().binary;
  }
  if (backend.id === "code-review-graph") {
    return graph?.codeReviewGraphPath ?? backend.processSpec().binary;
  }
  return backend.processSpec().binary;
}

/**
 * The backend's ProcessSpec with `binary` resolved via binaryForBackend().
 *
 * TokensaveMcpClient.spawnAndHandshake() resolves its transport binary as
 * `cfg.tokensavePath ?? processSpec.binary` (mcp-client.ts:243) — that
 * precedence is load-bearing for an EXISTING test (mcp-client.test.ts:381-401)
 * and must not change. So for the cr-graph backend (where cfg.tokensavePath is
 * never set), threading `codeReviewGraphPath` through here — rather than
 * touching mcp-client.ts — is what makes the override actually reach the
 * spawned `code-review-graph serve` subprocess.
 *
 * bober: a config that sets BOTH `tokensavePath` AND `backend:"code-review-graph"`
 * still has mcp-client.ts prefer `tokensavePath` (mcp-client.ts:243's own
 * precedence, untouched here) — a documented, low-probability residual
 * ambiguity. Reconciling it would require changing mcp-client.ts's own
 * precedence, which risks the tokensavePath-override test above; deferred.
 */
export function processSpecForBackend(
  backend: GraphBackend,
  config: BoberConfig,
): ProcessSpec {
  return { ...backend.processSpec(), binary: binaryForBackend(backend, config) };
}

// ── Errors ───────────────────────────────────────────────────────────

export class GraphBackendResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphBackendResolutionError";
  }
}

// ── Resolver ─────────────────────────────────────────────────────────

export async function resolveGraphBackend(
  config: BoberConfig,
  deps: { probe?: VersionProbe } = {},
): Promise<GraphBackend> {
  const probe = deps.probe ?? defaultProbe;
  const explicit = config.graph?.backend;

  // Explicit selection wins — no probe of the other backend, no fallback.
  if (explicit) {
    const found = KNOWN_BACKENDS.find((b) => b.id === explicit);
    if (!found) {
      throw new GraphBackendResolutionError(
        `Unknown graph backend "${explicit}". Known backends: ${KNOWN_BACKENDS.map((b) => b.id).join(", ")}`,
      );
    }
    return found;
  }

  // Auto-detect: probe each known backend, in preference order, and return
  // the first one detected as installed.
  for (const backend of KNOWN_BACKENDS) {
    const spec = backend.prereqSpec();
    const binary = binaryForBackend(backend, config);
    const result = await probe(binary, spec.versionArgs);
    if (result.ok) return backend;
  }

  // Neither installed — combined hint naming BOTH backends.
  const hints = KNOWN_BACKENDS.map(
    (b) => `${b.id}: ${b.prereqSpec().installHint(process.platform)}`,
  ).join("; ");
  throw new GraphBackendResolutionError(
    `No supported graph backend detected. Install one of — ${hints}`,
  );
}
