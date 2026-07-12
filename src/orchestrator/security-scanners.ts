import { execa } from "execa";

import type { EvalStrategy } from "../config/schema.js";
import type { SecurityFinding, VulnClass } from "./security-audit-types.js";
import { ALL_VULN_CLASSES } from "./stack-knowledge.js";
import { logger } from "../utils/logger.js";

/**
 * Deterministic scanner pre-filter (arch-20260712 ADR-4).
 *
 * Runs each `config.security.scanners` command under the shared audit
 * AbortSignal, parses known scanner output (slither, semgrep) into
 * SecurityFinding[] priors, and degrades unknown scanners to a bounded
 * raw-text excerpt finding. Every scanner is isolated: a missing binary,
 * nonzero exit, or thrown error yields `[]` for that scanner only — the
 * pre-filter itself NEVER rejects (runSecurityAudit's Promise.race time-box
 * must be able to trust that this always settles).
 */

// ── Injectable runner (keeps tests off real binaries) ────────────────

/** The minimal result shape runScannerPreFilter needs from a child process. */
export interface ScannerRunResult {
  exitCode: number | undefined;
  stdout: string;
  failed: boolean;
}

/**
 * Runs one scanner command and resolves with its outcome. NEVER expected to
 * reject in production (the default implementation uses execa's `reject:
 * false`); the caller wraps every invocation in try/catch anyway as a
 * defensive backstop (mirrors src/fleet/runner.ts's "reject:false plus
 * try/catch" belt-and-suspenders pattern).
 */
export type ScannerRunner = (
  cmd: string,
  args: string[],
  opts: { cwd: string; signal: AbortSignal },
) => Promise<ScannerRunResult>;

// bober: 10 MB cap on captured stdout — a pathological scanner (infinite
// output loop, huge repo dump) cannot exhaust memory or blow the prompt.
const MAX_SCANNER_BUFFER = 1024 * 1024 * 10;

/**
 * Default runner: wraps execa. `cancelSignal` ties the child's lifetime to
 * the shared audit AbortSignal; `killSignal: "SIGKILL"` makes both a normal
 * `.kill()` and a cancelSignal-triggered termination send SIGKILL directly
 * (no SIGTERM grace period) so an aborted scan cannot linger (sc-5-3).
 * `reject: false` means a missing binary (ENOENT) or nonzero exit resolves
 * normally instead of throwing (sc-5-2).
 */
const defaultRunner: ScannerRunner = async (cmd, args, opts) => {
  const result = await execa(cmd, args, {
    cwd: opts.cwd,
    cancelSignal: opts.signal,
    killSignal: "SIGKILL",
    reject: false,
    all: true,
    maxBuffer: MAX_SCANNER_BUFFER,
    env: { ...process.env, FORCE_COLOR: "0" },
  });

  return {
    exitCode: result.exitCode,
    stdout: result.all ?? result.stdout ?? "",
    failed: result.failed,
  };
};

// ── vulnClass heuristic (shared by both parsers) ─────────────────────

function isVulnClass(value: string): value is VulnClass {
  return (ALL_VULN_CLASSES as string[]).includes(value);
}

/**
 * Heuristically infer a VulnClass from a scanner check/rule id, by matching
 * well-known keyword tokens. Returns undefined (never a guess) when nothing
 * matches — per generatorNotes[1], forcing a wrong class is worse than
 * leaving vulnClass unset. e.g. slither's "reentrancy-eth" has no clean
 * VulnClass home and correctly stays undefined; "tx-origin" cleanly maps to
 * authn-authz (tx.origin-based authorization is exactly that bug class).
 *
 * bober: substring/keyword matching, not a per-scanner mapping table — good
 * enough to ground the advisory priors; if this proves noisy, replace with
 * an explicit per-check-id map keyed by scanner name.
 */
function inferVulnClass(checkId: string): VulnClass | undefined {
  const id = checkId.toLowerCase();

  const candidate: string | undefined =
    /sql-?injection|sqli|command-injection|code-injection|\bxss\b|\binjection\b/.test(id)
      ? "injection"
      : /path-traversal|directory-traversal/.test(id)
        ? "path-traversal"
        : /hardcoded|secret|credential|api-key/.test(id)
          ? "secret-handling"
          : /tx-origin|access-control|\bauth\b|authn|authz|authentication|authorization|privilege/.test(id)
            ? "authn-authz"
            : /unvalidated|input-validation|missing-validation|sanitiz/.test(id)
              ? "input-validation"
              : undefined;

  return candidate !== undefined && isVulnClass(candidate) ? candidate : undefined;
}

// ── Pure parsers (unknown → SecurityFinding[]; never throw) ──────────

/**
 * Parse slither `--json` output into SecurityFinding[].
 *
 * Real shape: `{ success, error, results: { detectors: [...] } }`. Each
 * detector: `{ check, impact, confidence, description, elements: [{ type,
 * name, source_mapping: { filename_relative, filename_absolute, lines[],
 * starting_column } }] }`.
 *
 * SecurityFinding has no top-level severity field (ReviewFinding locks
 * description + evidence[]) — the impact bucket is encoded as a `[High]`
 * style prefix on `description`, and `source: "slither"` marks provenance.
 *
 * Defensive narrowing at every level (Pattern A / medline-source.ts style):
 * any structural mismatch returns `[]` rather than throwing. Accepts a raw
 * (non-object) value too — e.g. a truncated JSON string passed directly —
 * so callers never need to guard before calling this.
 */
export function parseSlitherOutput(json: unknown): SecurityFinding[] {
  if (!json || typeof json !== "object" || Array.isArray(json)) return [];

  const root = json as Record<string, unknown>;
  const results = root.results;
  if (!results || typeof results !== "object" || Array.isArray(results)) return [];

  const detectors = (results as Record<string, unknown>).detectors;
  if (!Array.isArray(detectors)) return [];

  const findings: SecurityFinding[] = [];

  for (const detector of detectors) {
    if (!detector || typeof detector !== "object") continue;
    const d = detector as Record<string, unknown>;

    const check = typeof d.check === "string" ? d.check : "unknown-check";
    const impact = typeof d.impact === "string" ? d.impact : "Informational";
    const description = typeof d.description === "string" ? d.description.trim() : check;

    const elements = Array.isArray(d.elements) ? d.elements : [];
    const evidence: SecurityFinding["evidence"] = [];

    for (const el of elements) {
      if (!el || typeof el !== "object") continue;
      const e = el as Record<string, unknown>;

      const sourceMapping = e.source_mapping;
      if (!sourceMapping || typeof sourceMapping !== "object") continue;
      const sm = sourceMapping as Record<string, unknown>;

      const path =
        typeof sm.filename_relative === "string"
          ? sm.filename_relative
          : typeof sm.filename_absolute === "string"
            ? sm.filename_absolute
            : "unknown";

      const lines = Array.isArray(sm.lines) ? sm.lines : [];
      const line = typeof lines[0] === "number" ? lines[0] : 0;

      const elName = typeof e.name === "string" ? e.name : "";
      const elType = typeof e.type === "string" ? e.type : "";
      const snippet = [elType, elName].filter(Boolean).join(" ") || check;

      evidence.push({ path, line, snippet });
    }

    findings.push({
      description: `[${impact}] ${check}: ${description}`,
      evidence,
      source: "slither",
      ...(inferVulnClass(check) !== undefined ? { vulnClass: inferVulnClass(check) } : {}),
    });
  }

  return findings;
}

/**
 * Parse semgrep `--json` output into SecurityFinding[].
 *
 * Real shape: `{ results: [...], errors: [], paths: {...} }`. Each result:
 * `{ check_id, path, start: { line, col }, end: {...}, extra: { severity,
 * message, lines } }`.
 *
 * Same severity-in-description convention as the slither parser
 * (`[ERROR]`/`[WARNING]`/`[INFO]` prefix + `source: "semgrep"`); same
 * defensive narrowing (malformed input → `[]`, never throws).
 */
export function parseSemgrepOutput(json: unknown): SecurityFinding[] {
  if (!json || typeof json !== "object" || Array.isArray(json)) return [];

  const root = json as Record<string, unknown>;
  const results = root.results;
  if (!Array.isArray(results)) return [];

  const findings: SecurityFinding[] = [];

  for (const r of results) {
    if (!r || typeof r !== "object") continue;
    const item = r as Record<string, unknown>;

    const checkId = typeof item.check_id === "string" ? item.check_id : "unknown-rule";
    const path = typeof item.path === "string" ? item.path : "unknown";

    const start = item.start;
    const line =
      start && typeof start === "object" && typeof (start as Record<string, unknown>).line === "number"
        ? ((start as Record<string, unknown>).line as number)
        : 0;

    const extra = item.extra && typeof item.extra === "object" ? (item.extra as Record<string, unknown>) : {};
    const severity = typeof extra.severity === "string" ? extra.severity : "INFO";
    const message = typeof extra.message === "string" ? extra.message.trim() : checkId;
    const snippet = typeof extra.lines === "string" ? extra.lines : "";

    findings.push({
      description: `[${severity}] ${checkId}: ${message}`,
      evidence: [{ path, line, snippet }],
      source: "semgrep",
      ...(inferVulnClass(checkId) !== undefined ? { vulnClass: inferVulnClass(checkId) } : {}),
    });
  }

  return findings;
}

/**
 * Fallback for unrecognized scanners: a single finding carrying a bounded
 * excerpt of the raw stdout, so an unmapped tool still contributes SOME
 * ground truth to the auditor prompt instead of being silently dropped.
 * Truncated to ~2000 chars (generatorNotes[2]) to keep the prompt bounded.
 * Returns `[]` for blank output — no point manufacturing an empty finding.
 */
function rawTextFallback(name: string, output: string): SecurityFinding[] {
  const trimmed = output.trim();
  if (!trimmed) return [];

  const excerpt = trimmed.length > 2000 ? `${trimmed.slice(0, 2000)}…` : trimmed;

  return [
    {
      description: `Raw output from scanner "${name}" (no dedicated parser; showing excerpt)`,
      evidence: [{ path: "unknown", line: 0, snippet: excerpt }],
      source: name,
    },
  ];
}

// ── Parser selection by scanner type/label/command ───────────────────

type ScannerKind = "slither" | "semgrep" | "unknown";

/**
 * Name/command-based parser selection (sc-5-4): a "slither" or "semgrep"
 * substring anywhere in the strategy's type/label/command selects the
 * matching parser; anything else falls back to raw-text excerpting.
 */
function detectScannerKind(scanner: EvalStrategy): ScannerKind {
  const haystack = [scanner.type, scanner.label, scanner.command]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();

  if (haystack.includes("slither")) return "slither";
  if (haystack.includes("semgrep")) return "semgrep";
  return "unknown";
}

function parseScannerStdout(kind: ScannerKind, label: string, stdout: string): SecurityFinding[] {
  if (kind === "unknown") return rawTextFallback(label, stdout);

  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    // A scanner named "slither"/"semgrep" that didn't emit valid JSON (e.g.
    // --json flag omitted, or a banner printed before the payload) degrades
    // to the raw-text fallback rather than silently dropping its output.
    return rawTextFallback(label, stdout);
  }

  return kind === "slither" ? parseSlitherOutput(json) : parseSemgrepOutput(json);
}

// ── runScannerPreFilter ────────────────────────────────────────────────

export interface ScannerPreFilterInput {
  scanners: EvalStrategy[];
  projectRoot: string;
  signal: AbortSignal;
  /** Injected runner — default wraps execa. Tests inject a fake for CI-offline coverage. */
  runner?: ScannerRunner;
}

/**
 * Run every configured scanner and return the combined SecurityFinding
 * priors. `scanners: []` is a pure no-op — no runner is invoked and zero
 * child processes are spawned (ADR-4, sc-5-4).
 *
 * Per-scanner isolation: each scanner is wrapped in its own try/catch and
 * contributes `[]` on any failure (missing binary, nonzero exit, thrown
 * error) without affecting the others (sc-5-2). The whole function NEVER
 * rejects — even when the shared AbortSignal fires mid-scan, the killed
 * scanner simply contributes `[]` while already-finished scanners' findings
 * are preserved (sc-5-3).
 */
export async function runScannerPreFilter(input: ScannerPreFilterInput): Promise<SecurityFinding[]> {
  const { scanners, projectRoot, signal, runner = defaultRunner } = input;

  if (scanners.length === 0) return [];

  const perScanner = await Promise.all(
    scanners.map((scanner) => runOneScanner(scanner, projectRoot, signal, runner)),
  );

  return perScanner.flat();
}

async function runOneScanner(
  scanner: EvalStrategy,
  projectRoot: string,
  signal: AbortSignal,
  runner: ScannerRunner,
): Promise<SecurityFinding[]> {
  const label = scanner.label ?? scanner.type;
  const command = scanner.command;

  if (!command) {
    logger.debug(`[security-scanners] scanner "${label}" has no command configured — skipping`);
    return [];
  }

  const parts = command.split(/\s+/).filter(Boolean);
  const cmd = parts[0];
  const args = parts.slice(1);
  const kind = detectScannerKind(scanner);

  try {
    const result = await runner(cmd, args, { cwd: projectRoot, signal });

    // bober: nonzero exit -> [] for this scanner, even for a tool whose own
    // convention treats nonzero as "findings present" (e.g. semgrep --error).
    // Operators wiring such a scanner should configure the command so the
    // process itself exits 0; revisit per-scanner exit-code conventions if
    // this proves too coarse.
    if (result.exitCode !== 0 || result.failed) {
      logger.debug(
        `[security-scanners] scanner "${label}" exited ${result.exitCode ?? "unknown"} (failed=${result.failed}) — no findings contributed`,
      );
      return [];
    }

    return parseScannerStdout(kind, label, result.stdout);
  } catch (err) {
    logger.debug(
      `[security-scanners] scanner "${label}" threw: ${err instanceof Error ? err.message : String(err)} — no findings contributed`,
    );
    return [];
  }
}
