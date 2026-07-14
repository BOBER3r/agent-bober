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
    /sql-?injection|sqli|command-injection|code-injection|\binjection\b/.test(id)
      ? "injection"
      : /\bxss\b|cross-site-scripting/.test(id)
        ? "xss"
        : /path-traversal|directory-traversal/.test(id)
          ? "path-traversal"
          : /hardcoded|secret|credential|api-key/.test(id)
            ? "secret-handling"
            : /tx-origin|access-control|\bauth\b|authn|authz|authentication|authorization|privilege/.test(id)
              ? "authn-authz"
              : /unvalidated|input-validation|missing-validation|sanitiz/.test(id)
                ? "input-validation"
                : /\brace\b|toctou|time-of-check/.test(id)
                  ? "race-condition"
                  : /\bssrf\b|server-side-request/.test(id)
                    ? "ssrf"
                    : /weak-random|insecure-random|predictable-random/.test(id)
                      ? "insecure-randomness"
                      : /\bmd5\b|\bsha1\b|weak-crypto|weak-hash|weak-cipher/.test(id)
                        ? "crypto-weakness"
                        : /deserial|unmarshal|pickle/.test(id)
                          ? "deserialization"
                          : /\bidor\b|\bbola\b|broken-object-level/.test(id)
                            ? "idor-bola"
                            : /\bdos\b|denial-of-service|resource-exhaustion/.test(id)
                              ? "denial-of-service"
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
 * Parse `npm audit --json` output into SecurityFinding[].
 *
 * v7+ shape: `{ vulnerabilities: { <pkgName>: { name, severity, via: [...],
 * range, nodes: [...], fixAvailable } }, metadata: {...} }`. `via` entries
 * mix plain advisory-source strings and objects `{ title, url, severity }`
 * in the same array — real npm output does this.
 *
 * v6 fallback shape: `{ advisories: { <id>: { module_name, severity, title,
 * url } } }`. Both shapes are supported (whichever key is a well-formed
 * object wins); neither present, or malformed -> [].
 *
 * All findings map to `vulnClass: "supply-chain"` (sc-7-2). Defensive
 * narrowing at every level (Pattern A) — never throws.
 */
export function parseNpmAuditOutput(json: unknown): SecurityFinding[] {
  if (!json || typeof json !== "object" || Array.isArray(json)) return [];
  const root = json as Record<string, unknown>;

  const vulnerabilities = root.vulnerabilities;
  if (vulnerabilities && typeof vulnerabilities === "object" && !Array.isArray(vulnerabilities)) {
    const findings: SecurityFinding[] = [];
    for (const [pkgName, raw] of Object.entries(vulnerabilities as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const v = raw as Record<string, unknown>;

      const name = typeof v.name === "string" ? v.name : pkgName;
      const severity = typeof v.severity === "string" ? v.severity : "unknown";
      const range = typeof v.range === "string" ? v.range : "";

      const via = Array.isArray(v.via) ? v.via : [];
      const titles = via
        .map((entry) => {
          if (typeof entry === "string") return entry;
          if (entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).title === "string") {
            return (entry as Record<string, unknown>).title as string;
          }
          return undefined;
        })
        .filter((t): t is string => typeof t === "string");
      const summary = titles.length > 0 ? titles.join("; ") : `vulnerable range ${range || "unknown"}`;

      const nodes = Array.isArray(v.nodes)
        ? v.nodes.filter((n): n is string => typeof n === "string")
        : [];
      const path = nodes[0] ?? "package.json";

      findings.push({
        description: `[${severity}] ${name}: ${summary}`,
        evidence: [{ path, line: 0, snippet: range || name }],
        source: "npm-audit",
        vulnClass: "supply-chain",
      });
    }
    return findings;
  }

  const advisories = root.advisories;
  if (advisories && typeof advisories === "object" && !Array.isArray(advisories)) {
    const findings: SecurityFinding[] = [];
    for (const raw of Object.values(advisories as Record<string, unknown>)) {
      if (!raw || typeof raw !== "object") continue;
      const a = raw as Record<string, unknown>;

      const name = typeof a.module_name === "string" ? a.module_name : "unknown-package";
      const severity = typeof a.severity === "string" ? a.severity : "unknown";
      const title = typeof a.title === "string" ? a.title : "vulnerability";

      findings.push({
        description: `[${severity}] ${name}: ${title}`,
        evidence: [{ path: "package.json", line: 0, snippet: name }],
        source: "npm-audit",
        vulnClass: "supply-chain",
      });
    }
    return findings;
  }

  return [];
}

/**
 * Parse `osv-scanner --format json` output into SecurityFinding[].
 *
 * Real shape: `{ results: [ { source: { path, type }, packages: [ {
 * package: { name, ecosystem, version }, vulnerabilities: [ { id, summary,
 * severity } ] } ] } ] }`. Every finding maps to `vulnClass: "supply-chain"`
 * (sc-7-2). Defensive narrowing at every level (Pattern A) — never throws.
 */
export function parseOsvOutput(json: unknown): SecurityFinding[] {
  if (!json || typeof json !== "object" || Array.isArray(json)) return [];
  const root = json as Record<string, unknown>;
  const results = root.results;
  if (!Array.isArray(results)) return [];

  const findings: SecurityFinding[] = [];

  for (const result of results) {
    if (!result || typeof result !== "object") continue;
    const r = result as Record<string, unknown>;

    const source = r.source && typeof r.source === "object" ? (r.source as Record<string, unknown>) : {};
    const path = typeof source.path === "string" ? source.path : "unknown";

    const packages = Array.isArray(r.packages) ? r.packages : [];
    for (const pkg of packages) {
      if (!pkg || typeof pkg !== "object") continue;
      const p = pkg as Record<string, unknown>;

      const pkgInfo = p.package && typeof p.package === "object" ? (p.package as Record<string, unknown>) : {};
      const pkgName = typeof pkgInfo.name === "string" ? pkgInfo.name : "unknown-package";

      const vulns = Array.isArray(p.vulnerabilities) ? p.vulnerabilities : [];
      for (const vuln of vulns) {
        if (!vuln || typeof vuln !== "object") continue;
        const vv = vuln as Record<string, unknown>;

        const id = typeof vv.id === "string" ? vv.id : "unknown-id";
        const summary = typeof vv.summary === "string" ? vv.summary : "no summary";

        findings.push({
          description: `[${id}] ${pkgName}: ${summary}`,
          evidence: [{ path, line: 0, snippet: pkgName }],
          source: "osv-scanner",
          vulnClass: "supply-chain",
        });
      }
    }
  }

  return findings;
}

/**
 * Parse `gitleaks --report-format json` output into SecurityFinding[]. Its
 * report is a TOP-LEVEL ARRAY (unlike npm-audit/osv-scanner's object root)
 * of `{ Description, File, StartLine, EndLine, RuleID, Secret, Match,
 * Commit }`.
 *
 * The raw `Secret` field is a live credential — it is NEVER echoed into a
 * finding; `Match` (or a redacted placeholder) is used for the evidence
 * snippet instead. Every finding maps to `vulnClass: "secret-handling"`
 * (sc-7-2). Defensive narrowing at every level (Pattern A) — never throws.
 */
export function parseGitleaksOutput(json: unknown): SecurityFinding[] {
  if (!Array.isArray(json)) return [];

  const findings: SecurityFinding[] = [];

  for (const item of json) {
    if (!item || typeof item !== "object") continue;
    const g = item as Record<string, unknown>;

    const description = typeof g.Description === "string" ? g.Description : "Secret detected";
    const ruleId = typeof g.RuleID === "string" ? g.RuleID : "unknown-rule";
    const path = typeof g.File === "string" ? g.File : "unknown";
    const line = typeof g.StartLine === "number" ? g.StartLine : 0;
    // Never the raw `Secret` — `Match` is the closest thing to a redacted
    // excerpt gitleaks provides; fall back to a placeholder if absent.
    const snippet = typeof g.Match === "string" ? g.Match : "(redacted)";

    findings.push({
      description: `[${ruleId}] ${description}`,
      evidence: [{ path, line, snippet }],
      source: "gitleaks",
      vulnClass: "secret-handling",
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

type ScannerKind = "slither" | "semgrep" | "npm-audit" | "osv-scanner" | "gitleaks" | "unknown";

/**
 * Name/command-based parser selection (sc-5-4, widened sc-7-2): a
 * "slither"/"semgrep"/"npm audit"/"npm-audit"/"osv-scanner"/"gitleaks"
 * substring anywhere in the strategy's type/label/command selects the
 * matching parser; anything else falls back to raw-text excerpting. The
 * longer "osv-scanner" literal is checked before the bare "osv" substring
 * so a command like `osv-scanner --format json` matches unambiguously.
 */
function detectScannerKind(scanner: EvalStrategy): ScannerKind {
  const haystack = [scanner.type, scanner.label, scanner.command]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();

  if (haystack.includes("slither")) return "slither";
  if (haystack.includes("semgrep")) return "semgrep";
  if (haystack.includes("npm audit") || haystack.includes("npm-audit")) return "npm-audit";
  if (haystack.includes("osv-scanner") || haystack.includes("osv")) return "osv-scanner";
  if (haystack.includes("gitleaks")) return "gitleaks";
  return "unknown";
}

function parseScannerStdout(kind: ScannerKind, label: string, stdout: string): SecurityFinding[] {
  if (kind === "unknown") return rawTextFallback(label, stdout);

  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    // A scanner with a recognized kind that didn't emit valid JSON (e.g.
    // --json flag omitted, or a banner printed before the payload) degrades
    // to the raw-text fallback rather than silently dropping its output.
    return rawTextFallback(label, stdout);
  }

  switch (kind) {
    case "slither":
      return parseSlitherOutput(json);
    case "npm-audit":
      return parseNpmAuditOutput(json);
    case "osv-scanner":
      return parseOsvOutput(json);
    case "gitleaks":
      return parseGitleaksOutput(json);
    case "semgrep":
    default:
      return parseSemgrepOutput(json);
  }
}

// ── Exit-code convention per scanner kind (G9, sprint 7) ──────────────

type ScannerExitPolicy = "zero-clean" | "nonzero-means-findings";

/**
 * Exit-code convention for a given scanner kind (G9). Most scanners (the
 * default semgrep invocation, and unknown kinds) exit 0 on a clean run and
 * nonzero on an internal error — nonzero legitimately means "discard, don't
 * trust the output" (`'zero-clean'`). `npm-audit`/`osv-scanner`/`gitleaks`
 * invert this: their OWN convention is to exit nonzero precisely WHEN they
 * find something (vulnerabilities/secrets present), so a nonzero exit with
 * valid stdout must still be parsed (`'nonzero-means-findings'`). semgrep
 * has an optional `--error` flag with the same nonzero-on-findings
 * convention, but it stays `'zero-clean'` by default here — flipping it
 * would break the existing sc-5-2 isolation test, which asserts a nonzero
 * semgrep exit yields no findings.
 */
function scannerExitPolicy(kind: ScannerKind): ScannerExitPolicy {
  return kind === "npm-audit" || kind === "osv-scanner" || kind === "gitleaks"
    ? "nonzero-means-findings"
    : "zero-clean";
}

/**
 * Whether a configured scanner requires network access to run (hits a
 * remote registry or vulnerability database). Used by the supply-chain axis
 * (sprint 7, security-auditor-agent.ts) to gate network-capable scanner
 * kinds behind `config.security.egress.onlineResearch` — `gitleaks` is a
 * purely local secret scan and is NOT gated.
 */
export function isNetworkScanner(scanner: EvalStrategy): boolean {
  const kind = detectScannerKind(scanner);
  return kind === "npm-audit" || kind === "osv-scanner";
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

    // G9 fix: distinguish "the process could not even be spawned"
    // (exitCode undefined -- ENOENT/spawn failure) from "the process ran
    // and exited nonzero". Only the former is unconditionally discarded.
    const spawnFailed = result.exitCode === undefined;
    if (spawnFailed) {
      logger.debug(`[security-scanners] scanner "${label}" failed to spawn — no findings contributed`);
      return [];
    }

    // Scanners whose OWN convention treats nonzero as "findings present"
    // (npm-audit/osv-scanner/gitleaks — scannerExitPolicy) still have their
    // stdout parsed on a nonzero-but-defined exit code; everything else
    // (including semgrep's default 0-clean convention) is discarded on any
    // nonzero/failed exit, exactly as before.
    if (scannerExitPolicy(kind) === "zero-clean" && (result.exitCode !== 0 || result.failed)) {
      logger.debug(
        `[security-scanners] scanner "${label}" exited ${result.exitCode} (failed=${result.failed}) — no findings contributed`,
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
