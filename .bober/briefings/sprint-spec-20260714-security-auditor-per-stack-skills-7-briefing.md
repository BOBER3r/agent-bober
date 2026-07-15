# Sprint Briefing: Supply-chain axis — scanner kinds + nonzero-exit fix (G9) + offline diff inspector (G5)

**Contract:** sprint-spec-20260714-security-auditor-per-stack-skills-7
**Generated:** 2026-07-14T00:00:00Z

> Read this end-to-end before your first edit. Every claim below is cited to a real file:line. The 5 target files are all in `src/`; the offline inspector is a NEW file. Default-off + zero-network + per-scanner isolation are the load-bearing invariants — violating any one fails an evaluator criterion.

---

## 1. Target Files

### `src/orchestrator/security-scanners.ts` (modify)

Four surgical changes: (a) widen `ScannerKind`, (b) add `scannerExitPolicy`, (c) branch on it in `runOneScanner`, (d) add 3 parsers + dispatch.

**THE G9 BUG — the nonzero-exit discard branch (lines 363-384, `runOneScanner`):**
```ts
  try {
    const result = await runner(cmd, args, { cwd: projectRoot, signal });

    // bober: nonzero exit -> [] for this scanner, even for a tool whose own
    // convention treats nonzero as "findings present" (e.g. semgrep --error).
    if (result.exitCode !== 0 || result.failed) {          // <-- security-scanners.ts:371  THE G9 DISCARD
      logger.debug(
        `[security-scanners] scanner "${label}" exited ${result.exitCode ?? "unknown"} (failed=${result.failed}) — no findings contributed`,
      );
      return [];
    }

    return parseScannerStdout(kind, label, result.stdout);
  } catch (err) {                                          // <-- ENOENT / thrown / abort path — KEEP returning []
    logger.debug(`... threw: ${...} — no findings contributed`);
    return [];
  }
```

**How to fix G9 (generatorNotes[1], sc-7-1) — distinguish "ran and exited nonzero WITH output" from "failed to spawn":**
The `ScannerRunResult` shape (security-scanners.ts:23-27) is your discriminator:
```ts
export interface ScannerRunResult {
  exitCode: number | undefined;   // undefined === the process could not be spawned (ENOENT)
  stdout: string;
  failed: boolean;                // execa's failed flag
}
```
- ENOENT / spawn failure surfaces as **`exitCode === undefined`** (execa's `reject:false` result). A thrown runner is caught by the existing `catch` (line 379) → `[]`. Abort → the child is SIGKILLed and resolves failed/`[]`. These MUST stay `[]` (per-scanner isolation, sc-5-2/sc-5-3 — do not regress).
- The fix: for kinds whose policy is `'nonzero-means-findings'`, when the process **actually ran** (`exitCode !== undefined`, i.e. it spawned and exited with a code) parse stdout **regardless of a nonzero code**. Only the didn't-spawn case (`exitCode === undefined`) and the thrown/abort case return `[]`.

Recommended replacement of the discard branch (keep the debug log):
```ts
    const policy = scannerExitPolicy(kind);
    const spawnFailed = result.exitCode === undefined;   // ENOENT / could-not-spawn

    if (spawnFailed) {
      logger.debug(`[security-scanners] scanner "${label}" failed to spawn — no findings contributed`);
      return [];
    }
    if (policy === "zero-clean" && (result.exitCode !== 0 || result.failed)) {
      logger.debug(`[security-scanners] scanner "${label}" exited ${result.exitCode} (failed=${result.failed}) — no findings contributed`);
      return [];
    }
    // 'nonzero-means-findings' kinds fall through and parse stdout even on a nonzero exit.
    return parseScannerStdout(kind, label, result.stdout);
```
> NOTE: for `'nonzero-means-findings'`, do NOT gate on `result.failed` for a nonzero code — that's exactly the discard you're removing. But you STILL treat `exitCode === undefined` (spawn failure) as `[]`. This is the whole G9 fix, and sc-7-1's test injects `{exitCode:1, stdout:<valid json>}` (parse survives) vs an ENOENT (`exitCode:undefined` or a throw → `[]`).

**`scannerExitPolicy` — new helper to add (sc-7-1):**
```ts
type ScannerExitPolicy = "zero-clean" | "nonzero-means-findings";
function scannerExitPolicy(kind: ScannerKind): ScannerExitPolicy {
  // npm-audit/osv-scanner/gitleaks (and semgrep --error) exit nonzero WHEN they find things.
  return kind === "npm-audit" || kind === "osv-scanner" || kind === "gitleaks"
    ? "nonzero-means-findings"
    : "zero-clean";
}
```
> The contract text (sc-7-1) says "…and semgrep-with-error convention". `semgrep` is a single kind here; keep `semgrep` as `zero-clean` by default (its default exit is 0-on-clean and the existing sc-5-2 nonzero test at security-scanners.test.ts:252-273 asserts a nonzero semgrep yields `[]` — DO NOT break that test). Only the three NEW kinds flip to `nonzero-means-findings`. Mention the semgrep `--error` convention in a comment; do not change semgrep's policy.

**`ScannerKind` type + `detectScannerKind` (lines 276, 283-292):**
```ts
type ScannerKind = "slither" | "semgrep" | "unknown";              // <-- add "npm-audit" | "osv-scanner" | "gitleaks"

function detectScannerKind(scanner: EvalStrategy): ScannerKind {
  const haystack = [scanner.type, scanner.label, scanner.command]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();
  if (haystack.includes("slither")) return "slither";
  if (haystack.includes("semgrep")) return "semgrep";
  // add BEFORE the return "unknown":
  //   if (haystack.includes("npm audit") || haystack.includes("npm-audit")) return "npm-audit";
  //   if (haystack.includes("osv-scanner") || haystack.includes("osv")) return "osv-scanner";
  //   if (haystack.includes("gitleaks")) return "gitleaks";
  return "unknown";
}
```
> Ordering caution: check `gitleaks`/`osv-scanner`/`npm audit` substrings. `osv` is short — a `command` like `osv-scanner --format json` contains `osv-scanner`; prefer the longer literal first. sc-7-2 says "recognizes the three new kinds by type/label/command substring", matching the existing substring precedent.

**`parseScannerStdout` dispatch (lines 294-308) — add the 3 new arms:**
```ts
function parseScannerStdout(kind: ScannerKind, label: string, stdout: string): SecurityFinding[] {
  if (kind === "unknown") return rawTextFallback(label, stdout);
  let json: unknown;
  try { json = JSON.parse(stdout); } catch { return rawTextFallback(label, stdout); }
  return kind === "slither" ? parseSlitherOutput(json)
    : kind === "semgrep" ? parseSemgrepOutput(json)
    // add:
    // : kind === "npm-audit" ? parseNpmAuditOutput(json)
    // : kind === "osv-scanner" ? parseOsvOutput(json)
    // : kind === "gitleaks" ? parseGitleaksOutput(json)
    : parseSemgrepOutput(json);
}
```

**Imports this file uses (lines 1-6):** `execa`; type `EvalStrategy` from `../config/schema.js`; types `SecurityFinding, VulnClass` from `./security-audit-types.js`; `ALL_VULN_CLASSES` from `./stack-knowledge.js`; `logger` from `../utils/logger.js`.

**Imported by:** `src/orchestrator/security-auditor-agent.ts:17` (`runScannerPreFilter`); `src/orchestrator/security-scanners.test.ts:14-19` (`ScannerRunner`, `ScannerRunResult`, `parseSlitherOutput`, `parseSemgrepOutput`, `runScannerPreFilter`).

**Test file:** `src/orchestrator/security-scanners.test.ts` (exists — extend it).

---

### `src/orchestrator/security-knowledge/supply-chain-inspector.ts` (create)

**Directory pattern:** Files in `src/orchestrator/security-knowledge/` use kebab-case module names, each with a co-located `*.test.ts` (e.g. `diff-provider.ts`+`diff-provider.test.ts`, `resolver.ts`+`resolver.test.ts`). Named exports only, JSDoc header block per module.

**Most similar existing file:** `src/orchestrator/security-knowledge/diff-provider.ts` — mirror its (a) JSDoc "never throws / degrades to empty" contract, (b) exported input interface, (c) pure never-throw parsing helpers (`parseUnifiedDiff`, `parseHunks` at diff-provider.ts:184-283 are Pattern-B totals). It also OWNS the `AuditDiff`/`ChangedFile`/`DiffHunk` types you consume (diff-provider.ts:26-42).

**Structure template (follow this skeleton):**
```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AuditDiff, ChangedFile } from "./diff-provider.js";
import type { SecurityFinding } from "../security-audit-types.js";
import { logger } from "../../utils/logger.js";

export interface SupplyChainInspectInput {
  projectRoot: string;
  diff: AuditDiff;
  signal: AbortSignal;
}

/**
 * OFFLINE, zero-network supply-chain diff inspector (spec-20260714 sprint 7, G5).
 * Scoped to diff.changedFiles; reads current file content via node:fs/promises
 * ONLY for changed paths. NEVER throws (Pattern A) — any read/parse failure on
 * one file degrades to skipping that check, never a rejection.
 */
export async function inspectSupplyChain(input: SupplyChainInspectInput): Promise<SecurityFinding[]> {
  const { projectRoot, diff, signal } = input;
  const findings: SecurityFinding[] = [];
  for (const file of diff.changedFiles) {
    if (signal.aborted) break;
    try {
      // dispatch per filename: package.json / *lock* / .npmrc / .github/workflows/*.yml
    } catch {
      // one file's failure never drops the others (mirror collectGraphNeighborhood, diff-provider.ts:343-366)
    }
  }
  return findings;
}
```
> The contract's estimatedFiles names the entry `SupplyChainDiffInspector.inspect({projectRoot, diff, signal})` in some notes and `inspectSupplyChain(...)` in others. Pick a plain exported function (`inspectSupplyChain`) OR a const object with an `inspect` method — the diff-provider precedent uses a const object `securityDiffProvider` with `compute()` (diff-provider.ts:391). Match whichever the auditor-agent wiring (§4) imports; a plain function is simpler and has no injectable-seam requirement (the offline reads are pure fs). Whichever you choose, keep the `{projectRoot, diff, signal}` input shape from sc-7-4.

**Emit `SecurityFinding` (security-audit-types.ts:46-54), reusing the parser convention (§2):** `{ description, evidence: [{path,line,snippet}], source: "supply-chain-inspector", vulnClass: "supply-chain" }`.

**Test file:** `src/orchestrator/security-knowledge/supply-chain-inspector.test.ts` (create — craft `AuditDiff` fixtures like diff-provider.test.ts, §6).

---

### `src/config/schema.ts` (modify) — add `security.supplyChain` + `security.egress`, both `.optional()`, NO outer default

**Current `SecuritySectionSchema` (lines 223-247)** already has the exact pattern to copy — the sprint-6 `diff` field:
```ts
export const SecuritySectionSchema = z.object({
  enabled: z.boolean().default(false),
  failClosed: z.boolean().default(true),
  timeoutMs: z.number().int().positive().default(300_000),
  model: ModelChoiceSchema.default("opus"),
  maxTurns: z.number().int().min(1).default(20),
  provider: z.string().optional(),
  endpoint: z.string().nullable().optional(),
  providerConfig: z.record(z.string(), z.unknown()).optional(),
  budget: BudgetSectionSchema.optional(),
  scanners: z.array(EvalStrategySchema).default([]),        // <-- EvalStrategySchema is what supplyChain.scanners reuses
  standaloneBlockOn: z.enum(["critical", "important"]).default("critical"),
  hub: z.boolean().default(true),
  diff: SecurityDiffConfigSchema.optional(),                // <-- THE PATTERN: .optional(), no outer default (sc-6-3)
});
```

**Add these two (define the sub-schemas above the section like `SecurityDiffConfigSchema` at line 216, then reference `.optional()`):**
```ts
export const SecuritySupplyChainConfigSchema = z.object({
  enabled: z.boolean().default(false),
  scanners: z.array(EvalStrategySchema).default([]),
});
export type SecuritySupplyChainConfig = z.infer<typeof SecuritySupplyChainConfigSchema>;

export const SecurityEgressConfigSchema = z.object({
  onlineResearch: z.boolean().default(false),
});
export type SecurityEgressConfig = z.infer<typeof SecurityEgressConfigSchema>;
```
Then INSIDE `SecuritySectionSchema`, after `diff`:
```ts
  supplyChain: SecuritySupplyChainConfigSchema.optional(),
  egress: SecurityEgressConfigSchema.optional(),
```
> **CRITICAL tripwire (sc-7-3):** `.optional()` with NO outer default means `SecuritySectionSchema.parse({})` produces NO `supplyChain`/`egress` key → the deep-equal tripwires at **schema.test.ts:641-653** AND **schema.test.ts:701-713** stay byte-identical. If you add `.default({...})` instead, BOTH tests fail. This mirrors exactly how `diff` was added in sprint 6. `parse({ supplyChain: {} })` should then yield `{ enabled:false, scanners:[] }` (inner defaults materialize only when the key is present) — same as `parse({ diff: {} })` at schema.test.ts:716-718.

**`EvalStrategySchema` (lines 74-88)** — the exact schema `supplyChain.scanners` reuses; `command`/`type`/`label`/`required` are the fields `detectScannerKind` reads.

**Imported by:** `BoberConfigSchema` wires `security: SecuritySectionSchema.optional()` at schema.ts:652. `EvalStrategy`/`SecuritySection` types are imported broadly; adding optional keys is additive.

**Test file:** `src/config/schema.test.ts` (exists — add a `SecuritySectionSchema.supplyChain/egress` describe block mirroring lines 700-730).

---

### `src/orchestrator/security-auditor-agent.ts` (modify) — fold scanner + inspector priors when `supplyChain.enabled`

**The effectivePriors folding (RE-LOCATED by sprint 6 to lines 150-173):**
```ts
  // Sprint-5 seam: when scanners are configured, run the deterministic
  // pre-filter INSIDE the audit path ... and fold its findings in as priors.
  const configuredScanners = config.security?.scanners ?? [];
  let effectivePriors = priors;                                    // <-- security-auditor-agent.ts:156
  if (configuredScanners.length > 0) {
    const scannerAbort = new AbortController();
    const scannerTimer = setTimeout(() => scannerAbort.abort(), config.security?.timeoutMs ?? 300_000);
    try {
      const scannerPriors = await runScannerPreFilter({
        scanners: configuredScanners,
        projectRoot,
        signal: scannerAbort.signal,
      });
      effectivePriors = [...priors, ...scannerPriors];             // <-- security-auditor-agent.ts:169
    } finally {
      clearTimeout(scannerTimer);
    }
  }
```
The `auditDiff` variable (computed at lines 117-141) is IN SCOPE here — it's the `AuditDiff | undefined` the inspector consumes. Fold the supply-chain axis right AFTER the sprint-5 block, e.g.:
```ts
  const supplyChain = config.security?.supplyChain;
  if (supplyChain?.enabled) {
    const scAbort = new AbortController();
    const scTimer = setTimeout(() => scAbort.abort(), config.security?.timeoutMs ?? 300_000);
    try {
      // (a) network-gated scanner kinds — ONLY when egress.onlineResearch === true
      const onlineOk = config.security?.egress?.onlineResearch === true;
      const scScanners = onlineOk
        ? (supplyChain.scanners ?? [])
        : (supplyChain.scanners ?? []).filter((s) => !isNetworkScanner(s)); // npm-audit/osv-scanner require network
      const scannerPriors = scScanners.length > 0
        ? await runScannerPreFilter({ scanners: scScanners, projectRoot, signal: scAbort.signal })
        : [];
      // (b) ALWAYS-available offline inspector (runs even with zero external scanners, sc-7-5)
      const inspectorPriors = auditDiff
        ? await inspectSupplyChain({ projectRoot, diff: auditDiff, signal: scAbort.signal })
        : [];
      effectivePriors = [...effectivePriors, ...scannerPriors, ...inspectorPriors];
    } finally {
      clearTimeout(scTimer);
    }
  }
```
> `effectivePriors` flows into `buildUserMessage(... effectivePriors, auditDiff)` at line 175-184 and is rendered as the "# Deterministic scanner findings (ground truth priors)" prompt section (buildUserMessage lines 299-302). This is the ADR-4 "findings feed the finder as PRIORS" path — NOT a new LLM role/sub-auditor (nonGoals[3]).
>
> **Network gating (sc-7-3, nonGoals[1-2]):** `gitleaks` is OFFLINE (local secret scan) — it may run without egress. `npm-audit`/`osv-scanner` hit the registry/OSV DB → only when `egress.onlineResearch===true`. Add a small `isNetworkScanner(scanner)` helper keyed on `detectScannerKind` returning true for `npm-audit`/`osv-scanner`. Detect via the same substring logic OR export a predicate from security-scanners.ts. In tests, egress stays OFF everywhere (nonGoals[2]) so network scanners are always filtered out — the injected-runner scanner tests live in security-scanners.test.ts, and the auditor-agent test asserts the inspector prior reaches the finder with egress absent.
>
> `scannerRan` at security-auditor-agent.ts:226 currently reads `configuredScanners.length > 0 || effectivePriors.length > 0` — the supply-chain inspector adding priors will naturally make this true when it fires; no change needed, but verify the existing sprint-2 `scannerRan` test still holds.

**Imports to add:** `import { inspectSupplyChain } from "./security-knowledge/supply-chain-inspector.js";` (alongside the existing `runScannerPreFilter` import at line 17 and the `AuditDiff` type import at line 18).

**Test file:** covered by `src/orchestrator/security-auditor-agent.test.ts` (exists — grep confirms; sc-7-5 adds a test: a diff with a malicious postinstall → a supply-chain prior reaches the finder). Diff provider is already injectable via `deps.diffProvider` (SecurityAuditDeps, line 27-29) so tests craft an `AuditDiff` with a fake provider and never shell git.

---

## 2. Patterns to Follow

### Pattern A — Defensive-narrowing / never-throw parser (the 3 new parsers MUST mirror this)
**Source:** `security-scanners.ts`, lines 144-201 (`parseSlitherOutput`) and 214-250 (`parseSemgrepOutput`)
```ts
export function parseSemgrepOutput(json: unknown): SecurityFinding[] {
  if (!json || typeof json !== "object" || Array.isArray(json)) return [];   // top-level guard
  const root = json as Record<string, unknown>;
  const results = root.results;
  if (!Array.isArray(results)) return [];                                    // shape guard
  const findings: SecurityFinding[] = [];
  for (const r of results) {
    if (!r || typeof r !== "object") continue;                              // per-item guard
    const item = r as Record<string, unknown>;
    const checkId = typeof item.check_id === "string" ? item.check_id : "unknown-rule";
    const path = typeof item.path === "string" ? item.path : "unknown";
    // ... typeof-guard EVERY field access ...
    findings.push({
      description: `[${severity}] ${checkId}: ${message}`,
      evidence: [{ path, line, snippet }],
      source: "semgrep",
      ...(inferVulnClass(checkId) !== undefined ? { vulnClass: inferVulnClass(checkId) } : {}),
    });
  }
  return findings;
}
```
**Rule:** Every new parser takes `json: unknown`, guards the top-level shape (`!obj || typeof !== "object"` → `[]`), `Array.isArray` guards every array, `typeof x === "string"/"number"` guards every scalar, `continue` on a bad item — NEVER throws, malformed → `[]`. This is REQUIRED by sc-7-2 ("pure, total, malformed => []"), and the test table (§6) feeds garbage and asserts `[]`.

### Pattern — SecurityFinding emit shape
**Source:** `security-audit-types.ts`, lines 46-54; produced at `security-scanners.ts:192-197, 241-247`
```ts
export interface SecurityFinding extends ReviewFinding {   // ReviewFinding locks: description + evidence[{path,line,snippet}]
  vulnClass?: VulnClass;    // "supply-chain" | "secret-handling" | ... (17 values, security-audit-types.ts:9-27)
  cwe?: string; severity?: FindingSeverity; confidence?: FindingConfidence; taint?: TaintPath; signatureId?: string;
}
```
**Rule:** `description` (string), `evidence` (array of `{path,line,snippet}`), `source` (string — set to the scanner name / `"supply-chain-inspector"`), and `vulnClass` conditionally spread ONLY when defined (`...(x !== undefined ? {vulnClass:x} : {})`). `vulnClass` MUST be one of the 17 literal values — `"supply-chain"` and `"secret-handling"` both exist (security-audit-types.ts:22,12).

### Pattern — vulnClass mapping (npm-audit/osv → `supply-chain`; gitleaks → `secret-handling`)
**Source:** sc-7-2 + research D (line 175). npm-audit and osv findings are dependency vulns → `vulnClass: "supply-chain"`. gitleaks finds committed secrets → `vulnClass: "secret-handling"`. The offline inspector (§5) always emits `"supply-chain"`.

### Pattern — never-throw fs over changed paths (offline inspector precedent)
**Source:** `diff-provider.ts`, lines 343-366 (`collectGraphNeighborhood`) — per-item try/catch so one failure never drops the rest; and lines 402-445 (`compute`) — outer try/catch → `EMPTY_DIFF`.
**Rule:** The inspector wraps each changed-file check in try/catch, reads via `node:fs/promises`, and returns partial results on any failure. Honour `signal.aborted` between files (mirrors diff-provider.ts:351).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `runScannerPreFilter` | `security-scanners.ts:332` | `(input: ScannerPreFilterInput) => Promise<SecurityFinding[]>` | Runs configured scanners under abort, per-scanner isolated; reuse for supplyChain.scanners |
| `ScannerRunner` (type) | `security-scanners.ts:36-40` | `(cmd,args,{cwd,signal}) => Promise<ScannerRunResult>` | Injectable runner seam — tests inject fakes, never real binaries |
| `ScannerRunResult` (type) | `security-scanners.ts:23-27` | `{exitCode:number\|undefined; stdout:string; failed:boolean}` | The result shape; `exitCode===undefined` === spawn-failed (G9 discriminator) |
| `detectScannerKind` | `security-scanners.ts:283` | `(scanner: EvalStrategy) => ScannerKind` | Substring kind detection — extend with 3 new kinds |
| `parseScannerStdout` | `security-scanners.ts:294` | `(kind, label, stdout) => SecurityFinding[]` | JSON.parse + dispatch — extend with 3 new arms |
| `parseSlitherOutput` / `parseSemgrepOutput` | `security-scanners.ts:144 / 214` | `(json: unknown) => SecurityFinding[]` | The defensive-parser template to copy for the 3 new ones |
| `inferVulnClass` | `security-scanners.ts:90` | `(checkId: string) => VulnClass \| undefined` | Keyword→VulnClass; note it does NOT map "supply-chain" — set that literal directly |
| `rawTextFallback` | `security-scanners.ts:259` | `(name, output) => SecurityFinding[]` | Bounded excerpt for unknown scanners (unchanged) |
| `AuditDiff` / `ChangedFile` / `DiffHunk` (types) | `diff-provider.ts:38 / 32 / 26` | interfaces | The inspector's input; `ChangedFile{path,status,hunks:[{startLine,lineCount,content}]}` |
| `extractDiffKeywords` | `diff-provider.ts:308` | `(files: ChangedFile[]) => string[]` | Existing hunk tokenizer — note NOTABLE_SUBSTRINGS already lists `postinstall`, `eval(`, `child_process` (diff-provider.ts:288-301) |
| `EvalStrategySchema` / `EvalStrategy` | `schema.ts:74 / 88` | zod object / type | The scanner-strategy shape reused by `supplyChain.scanners` |
| `SecurityDiffConfigSchema` | `schema.ts:216` | `.optional()` sub-schema | The exact `.optional()`-no-default template for the 2 new config objects |
| `deriveVerdict` | `security-audit-types.ts` (imported at security-auditor-agent.ts:6) | `(review) => "pass"\|"blocked"` | Verdict derivation — priors don't change it directly, they feed the finder |
| `logger` | `../utils/logger.js` | `.debug/.info/.sprint` | The only logging util used across these files |

**Utilities reviewed:** `src/utils/`, `src/orchestrator/security-knowledge/`, `src/orchestrator/*.ts`. No existing supply-chain/lockfile/.npmrc/CI-workflow inspector exists (grep confirms — research G5, line 119: only unrelated `src/discovery/scanners/package-scripts.ts`). Do NOT import from `src/discovery/` — it is a different subsystem.

---

## 4. Prior Sprint Output

### Sprint 6: SecurityDiffProvider + AuditDiff (git-diff mode)
**Created:** `src/orchestrator/security-knowledge/diff-provider.ts` — exports `AuditDiff`, `ChangedFile`, `DiffHunk`, `EMPTY_DIFF`, `securityDiffProvider`, `parseUnifiedDiff`, `extractDiffKeywords`, `GitRunner`, `GitRunResult`.
**Connection to this sprint:** The `SupplyChainDiffInspector` consumes the `AuditDiff` that `runSecurityAudit` already computes at security-auditor-agent.ts:117-141 (opt-in via `config.security.diff.mode === "git-diff"`). `auditDiff.changedFiles[].hunks[].content` is the unified-diff text your inspector scans for lifecycle-script/lockfile/.npmrc/CI signatures. `ChangedFile.status` is `"added"|"modified"|"deleted"|"renamed"` (diff-provider.ts:34) — a new-dependency check keys on added package.json lines. When `diff.mode` is the default `"estimated-files"`, `auditDiff` is `undefined` → the inspector simply produces `[]` (guard `auditDiff ? inspect(...) : []`).

### Sprints 1-5 (context): SecuritySectionSchema, scanner pre-filter, vulnClass taxonomy
**Created/extended:** `SecuritySectionSchema` (schema.ts:223), `security-scanners.ts` (runScannerPreFilter, parsers, detectScannerKind), the 17-value `VulnClass` taxonomy including `"supply-chain"` (security-audit-types.ts:22) and `"secret-handling"` (:12).
**Connection:** You extend all three — schema gets 2 optional fields, scanners get 3 kinds + G9 fix, and the taxonomy values you emit already exist (no taxonomy change needed).

---

## 5. Relevant Documentation — Offline Inspector Detection Heuristics (research §D checklist)

**Source:** `.bober/research/research-20260714-security-auditor-pentest-deep-upgrade-research.md`, section D (lines 170-178), esp. the "Diff-review checklist (offline, no network)" at line 175. All emit `vulnClass: "supply-chain"`. Each check reads the current changed-file content OR scans the hunk `+` lines. Craft regexes against the added lines (lines starting `+` in `hunk.content`).

| # | Check (sc-7-4) | Where | Detection idea / regex |
|---|----------------|-------|------------------------|
| 1 | Malicious lifecycle script | `package.json` changed, `scripts.{preinstall,install,postinstall,prepare}` added/changed | Parse the file's JSON `scripts`; flag those 4 keys whose value matches obfuscation: `/(base64|Buffer\.from\([^)]*base64|eval\(|\\x[0-9a-f]{2}|atob\(|child_process|curl\s|wget\s|node\s+-e)/i` or long hex/base64 blobs `/[A-Za-z0-9+/]{80,}={0,2}/`. Research D line 171: "any lifecycle-script add/change, esp. minified/base64/hex/eval content". |
| 2 | Lockfile `resolved` host ≠ registry | `package-lock.json`/`yarn.lock`/`pnpm-lock.yaml` in changedFiles | Scan added lines for `"resolved":` URLs; flag hosts NOT in `{registry.npmjs.org, registry.yarnpkg.com}` → `/"resolved":\s*"https?:\/\/(?!registry\.npmjs\.org|registry\.yarnpkg\.com)([^/"]+)/`. Research D line 174 "lockfile injection (`resolved` host ≠ registry)". |
| 3 | `.npmrc` registry override / ignore-scripts disabled | `.npmrc` in changedFiles | Added lines matching `/^\s*registry\s*=/m` (custom registry), or `/ignore-scripts\s*=\s*false/` (scripts re-enabled), or a scoped `@scope:registry=`. Research D line 175. |
| 4 | New dependency with no matching import | `package.json` `dependencies`/`devDependencies` gains a key | For each added dep name, check the diff's changed non-package.json files for an `import`/`require` of it; if none in the diff → flag (offline heuristic; may FP — mark low-confidence in the description). Research D line 175 "new dep with no matching import". |
| 5 | CI uses `npm install` not `npm ci` | `.github/workflows/*.yml`/`*.yaml` in changedFiles | Added lines matching `/\bnpm\s+install\b/` (not `/\bnpm\s+ci\b/`). Research D line 174-175 "`npm install` vs `npm ci`". |
| 6 | GitHub Action pinned by tag not full SHA | `.github/workflows/*.yml` in changedFiles | `uses:` lines: `/uses:\s*[\w.-]+\/[\w.-]+@(v?\d[\w.-]*)\s*$/` (tag/branch) vs a 40-hex SHA `/@[0-9a-f]{40}/`. Flag the non-SHA pin. Research D line 174 "GitHub Actions tag-vs-SHA (tj-actions CVE-2025-30066)". |

**Filename dispatch:** key each check on `basename(file.path)` / path suffix — `package.json`, `*lock*` (`package-lock.json`/`yarn.lock`/`pnpm-lock.yaml`), `.npmrc`, and `.github/workflows/*.{yml,yaml}`. Only inspect files present in `diff.changedFiles` (sc-7-4 "scoped to the diff's changed files").

### Project Principles
No `.bober/principles.md` at repo root governing this sprint beyond the ADRs. ADR-4 (deterministic scanners + offline inspector, findings feed the finder as priors — NO dedicated supply-chain LLM sub-auditor) and ADR-5 (orchestrator owns the diff, not the auditor) are the binding decisions, stated in contract nonGoals[3] and diff-provider.ts:9.

### Architecture Decisions
`arch-20260712-security-audit-agent-team` (ADR-4/ADR-5, referenced in security-scanners.ts:9 and diff-provider.ts:9). The egress-axis precedent (default-false `onlineResearch`) is established at schema.ts:574-578 (research section) and schema.ts:478-489 (medical) — the contract's assumptions[3] names these as the pattern for `security.egress.onlineResearch`.

### Other Docs
`CLAUDE.md` / repo memory: per-scanner isolation and default-off are load-bearing invariants across this whole security-auditor spec. The dogfood config (`bober.config.json`) has `security.enabled:true` — so this repo's own future audits get the offline inspector once `supplyChain.enabled` is set, but it defaults off, so the dogfood config is unaffected unless the operator opts in.

---

## 6. Testing Patterns

### Unit Test Pattern — injected runner + fixtures (scanners)
**Source:** `src/orchestrator/security-scanners.test.ts:164-219`
```ts
import { describe, it, expect, vi } from "vitest";
import type { ScannerRunner, ScannerRunResult } from "./security-scanners.js";

const runner: ScannerRunner = vi.fn(async (): Promise<ScannerRunResult> => ({
  exitCode: 1, stdout: JSON.stringify(npmAuditPayload), failed: true,   // G9: nonzero + valid findings
}));
const findings = await runScannerPreFilter({
  scanners: [makeScanner({ type: "npm-audit", command: "npm audit --json" })],
  projectRoot: "/tmp/project",
  signal: new AbortController().signal,
  runner,
});
expect(findings.length).toBeGreaterThan(0);      // G9 fixed: findings SURVIVE the nonzero exit
```
For the ENOENT half of sc-7-1, inject `throw new Error("spawn npm ENOENT")` (mirrors security-scanners.test.ts:232) OR `{ exitCode: undefined, stdout:"", failed:true }` and assert `[]`.

**Table-test each parser (sc-7-2)** — mirror the `it.each` at security-scanners.test.ts:127-149 and the malformed-input tests at :65-76:
```ts
describe("parseNpmAuditOutput", () => {
  it("maps a real-shaped npm audit payload to supply-chain findings", () => {
    const findings = parseNpmAuditOutput(npmAuditV7Payload);
    expect(findings[0].vulnClass).toBe("supply-chain");
  });
  it.each([undefined, null, "{trunc", {}, [1,2,3], { vulnerabilities: "nope" }])("garbage %j -> []", (g) => {
    expect(parseNpmAuditOutput(g)).toEqual([]);
  });
});
```

**Runner:** vitest. **Assertion:** `expect(...)`. **Mock:** `vi.fn` injected runner (NO `vi.mock` for the runner — it's a constructor param). **File naming:** `<module>.test.ts` co-located. Fixtures load via `new URL("./__fixtures__/<name>", import.meta.url)` (security-scanners.test.ts:23-27) — you MAY inline the JSON payloads instead (simpler, and the diff-provider tests inline their fixtures as string consts, diff-provider.test.ts:34-60).

### Unit Test Pattern — crafting an AuditDiff (offline inspector)
**Source:** `src/orchestrator/security-knowledge/diff-provider.test.ts:34-60` shows the ChangedFile/hunk shape; construct `AuditDiff` fixtures directly:
```ts
import type { AuditDiff } from "./diff-provider.js";
const diff: AuditDiff = {
  changedFiles: [{
    path: "package.json",
    status: "modified",
    hunks: [{ startLine: 5, lineCount: 3, content:
      '@@ -5,1 +5,2 @@\n   "scripts": {\n+    "postinstall": "node -e \\"eval(Buffer.from(\'aGVsbG8=\',\'base64\').toString())\\""' }],
  }],
  neighborhoodFiles: [], truncated: false,
};
const findings = await inspectSupplyChain({ projectRoot: "/tmp/proj", diff, signal: new AbortController().signal });
expect(findings.some((f) => f.vulnClass === "supply-chain")).toBe(true);
```
> The inspector reads current file content via `node:fs/promises` for some checks. For checks that scan hunk text (lifecycle script content in the `+` lines, `.npmrc`, CI yml) you can assert purely from the crafted diff with NO real files. For the "new dep with no matching import" cross-file check, craft a diff whose changedFiles include both the package.json add and the (absent) import. Keep tests offline — NO real npm/osv/git (sc-7-6, nonGoals[2]). If a check needs to `readFile` a path, either write a tmp file under the scratchpad projectRoot OR design the check to prefer hunk content so tests need no fs.

### Config schema test (sc-7-3)
**Source:** `src/config/schema.test.ts:700-730` — copy the `diff` describe block:
```ts
it("parse({}) still has NO supplyChain/egress key — byte-identical", () => {
  const parsed = SecuritySectionSchema.parse({});
  expect(Object.hasOwn(parsed, "supplyChain")).toBe(false);
  expect(Object.hasOwn(parsed, "egress")).toBe(false);
});
it("parse({ supplyChain: {} }) defaults enabled:false, scanners:[]", () => {
  expect(SecuritySectionSchema.parse({ supplyChain: {} }).supplyChain).toEqual({ enabled: false, scanners: [] });
});
it("parse({ egress: {} }) defaults onlineResearch:false", () => {
  expect(SecuritySectionSchema.parse({ egress: {} }).egress).toEqual({ onlineResearch: false });
});
```
Do NOT edit the existing deep-equal at schema.test.ts:641-653 or :701-713 — they MUST stay green unchanged (that IS the byte-identical proof).

### Real-shaped JSON payloads for the 3 parsers (sc-7-2 table fixtures)
```jsonc
// npm audit --json  (v7+; parseNpmAuditOutput). Iterate Object.entries(vulnerabilities).
{ "vulnerabilities": {
    "minimist": { "name": "minimist", "severity": "critical",
      "via": [ { "title": "Prototype Pollution", "url": "https://github.com/advisories/GHSA-xxxx", "severity": "critical" } ],
      "range": "<1.2.6", "nodes": ["node_modules/minimist"], "fixAvailable": true } },
  "metadata": { "vulnerabilities": { "critical": 1 } } }
// v6 fallback shape: { "advisories": { "1179": { "module_name":"minimist","severity":"high","title":"...","url":"..." } } }
//   -> support BOTH: if obj.vulnerabilities is an object use it, else if obj.advisories is an object use that.

// osv-scanner --format json  (parseOsvOutput). results[].packages[].vulnerabilities[]
{ "results": [ { "source": { "path": "/repo/package-lock.json", "type": "lockfile" },
    "packages": [ { "package": { "name": "lodash", "ecosystem": "npm", "version": "4.17.20" },
      "vulnerabilities": [ { "id": "GHSA-p6mc-m468-83gg", "summary": "Prototype pollution in lodash",
        "severity": [ { "type": "CVSS_V3", "score": "7.4" } ] } ] } ] } ] }
//   -> path from source.path; description from vuln.id + vuln.summary; vulnClass "supply-chain".

// gitleaks --report-format json  (parseGitleaksOutput). TOP-LEVEL ARRAY.
[ { "Description": "AWS Access Key", "File": "src/config.ts", "StartLine": 12, "EndLine": 12,
    "RuleID": "aws-access-token", "Secret": "AKIA....", "Match": "const k = 'AKIA...'", "Commit": "abc123" } ]
//   -> Array.isArray(json) guard FIRST (unlike npm/osv which are objects); path=File, line=StartLine,
//      snippet=Match (NOT Secret — avoid echoing the raw secret; truncate/redact); vulnClass "secret-handling".
```
> Redaction note: gitleaks' `Secret` field is a live credential — do NOT put the raw `Secret` in the finding snippet; use `Match` or a redacted form. This matches the auditor's secret-handling posture.

### E2E Test Pattern
Not applicable — this is a Node/TS library sprint with no Playwright surface. (`playwright.config.ts` check: none relevant to these files.)

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/security-auditor-agent.ts` | `security-scanners.ts` (`runScannerPreFilter`), new `supply-chain-inspector.ts` | medium | `runScannerPreFilter` signature/return unchanged; new import resolves; effectivePriors folding stays additive |
| `src/orchestrator/security-scanners.test.ts` | `security-scanners.ts` (ScannerKind, parsers, runOneScanner) | medium | The sc-5-2 nonzero-exit test (:252-273) uses a `semgrep` scanner exiting nonzero → still `[]` (semgrep stays `zero-clean`). DO NOT flip semgrep to nonzero-means-findings |
| `src/config/schema.test.ts` | `SecuritySectionSchema` deep-equal (:641-653, :701-713) | high | Both `parse({})` deep-equals MUST stay byte-identical → supplyChain/egress MUST be `.optional()` no-default |
| Any consumer of `SecuritySection`/`BoberConfig` type | `schema.ts` | low | Additive optional fields — no existing consumer breaks |
| `src/orchestrator/security-knowledge/diff-provider.ts` | (unchanged; you only IMPORT its types) | low | Do not modify — import `AuditDiff`/`ChangedFile` as types only |

### Existing Tests That Must Still Pass
- `src/config/schema.test.ts:641-653` — `SecuritySectionSchema.parse({})` deep-equals the 8-key default set; the sprint-6 `diff` test at :701-713 re-asserts it. Adding `.optional()` fields keeps both green (they don't materialize a key). **This is the #1 regression risk.**
- `src/orchestrator/security-scanners.test.ts:252-273` — sc-5-2 "a nonzero exit yields [] for that scanner" uses `semgrep` with `{exitCode:1, failed:true}`; semgrep MUST remain `zero-clean` or this fails. Verify.
- `src/orchestrator/security-scanners.test.ts:223-250` — sc-5-2 ENOENT-throw isolation; your G9 change must not touch the `catch` return-`[]` path.
- `src/orchestrator/security-scanners.test.ts:278-333` — sc-5-3 abort → partial results; unchanged runner semantics.
- `src/orchestrator/security-scanners.test.ts:164-219` — sc-5-4 parser selection (slither/pylint fallback); detectScannerKind additions must not reclassify these.
- `src/orchestrator/security-auditor-agent.test.ts` — the sprint-2 `scannerRan` and sprint-5/6 folding/diff tests; the new supplyChain fold is inside an `if (supplyChain?.enabled)` so default-off callers are byte-identical.

### Features That Could Be Affected
- **Deterministic scanner pre-filter (sprint 5)** — shares `runOneScanner`/`detectScannerKind`/`parseScannerStdout`; verify slither/semgrep still parse and isolate exactly as before (G9 change is gated by `scannerExitPolicy`, so `zero-clean` kinds behave identically).
- **Real-diff provider (sprint 6)** — shares the `AuditDiff` computed in `runSecurityAudit`; the inspector is a pure consumer; verify git-diff-off (`estimated-files`) leaves `auditDiff` undefined → inspector yields `[]`.
- **Dogfood security audit (this repo, `security.enabled:true`)** — verify default behavior unchanged: without `supplyChain` in `bober.config.json`, the whole new path is skipped.

### Recommended Regression Checks (run AFTER implementation)
1. `npm run build` — TypeScript compiles (new exports resolve, no unused imports).
2. `npx vitest run src/config/schema.test.ts` — the two deep-equal tripwires green.
3. `npx vitest run src/orchestrator/security-scanners.test.ts` — sprint-5 isolation/abort/selection tests green + new G9 + 3-parser tests.
4. `npx vitest run src/orchestrator/security-knowledge/supply-chain-inspector.test.ts` — the 6 offline checks each flag their case; zero network.
5. `npx vitest run src/orchestrator/security-auditor-agent.test.ts` — the malicious-postinstall-reaches-finder test + existing folding tests.
6. `npm run typecheck && npm run lint` — clean.
7. `npm test` (full suite) — green; grep for accidental real `npm`/`osv`/`git` spawns in new tests (there must be none).

---

## 8. Implementation Sequence (dependency-ordered)

1. **`src/config/schema.ts`** — add `SecuritySupplyChainConfigSchema` + `SecurityEgressConfigSchema` (above the section, like `SecurityDiffConfigSchema` at :216), reference them `.optional()` inside `SecuritySectionSchema` after `diff` (:246). Export the inferred types.
   - Verify: `SecuritySectionSchema.parse({})` still deep-equals the 8-key set (no new key); `parse({supplyChain:{}})` → `{enabled:false,scanners:[]}`.
2. **`src/config/schema.test.ts`** — add the supplyChain/egress describe block (mirror :700-730); leave :641-653/:701-713 untouched.
   - Verify: `npx vitest run src/config/schema.test.ts` green.
3. **`src/orchestrator/security-scanners.ts`** — widen `ScannerKind` (:276); add `scannerExitPolicy`; add 3 parsers (`parseNpmAuditOutput`/`parseOsvOutput`/`parseGitleaksOutput`, Pattern A); extend `detectScannerKind` (:283) + `parseScannerStdout` dispatch (:294); rewrite the G9 discard branch (:371) to branch on `scannerExitPolicy` + `exitCode===undefined` spawn-fail guard. Export the 3 parsers (they're unit-tested directly) + optionally `isNetworkScanner`.
   - Verify: existing scanner tests green; a nonzero-exit npm-audit runner yields findings; ENOENT yields `[]`.
4. **`src/orchestrator/security-scanners.test.ts`** — add G9 test (sc-7-1) + 3 parser table-tests (sc-7-2, real payload + garbage→[]).
   - Verify: `npx vitest run src/orchestrator/security-scanners.test.ts` green.
5. **`src/orchestrator/security-knowledge/supply-chain-inspector.ts`** — create `inspectSupplyChain({projectRoot,diff,signal})`; implement the 6 offline checks from §5; never throws; scoped to `diff.changedFiles`; emit `vulnClass:"supply-chain"`.
   - Verify: pure/total; a crafted malicious-postinstall diff yields a finding.
6. **`src/orchestrator/security-knowledge/supply-chain-inspector.test.ts`** — create; one crafted-AuditDiff test per check (sc-7-4); assert zero network.
   - Verify: `npx vitest run .../supply-chain-inspector.test.ts` green.
7. **`src/orchestrator/security-auditor-agent.ts`** — import `inspectSupplyChain`; after the sprint-5 fold (:173), add the `if (config.security?.supplyChain?.enabled)` block folding scanner priors (network-gated) + inspector priors into `effectivePriors`; reuse the existing `auditDiff` variable.
   - Verify: default-off path byte-identical; `supplyChain.enabled` + a diff → inspector prior reaches `buildUserMessage`.
8. **`src/orchestrator/security-auditor-agent.test.ts`** — add sc-7-5 test (malicious-postinstall diff via injected `deps.diffProvider` → supply-chain prior in the priors section).
   - Verify: green; existing folding/verdict tests unaffected.
9. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`.

---

## 9. Pitfalls & Warnings

- **G9 discriminator is `exitCode === undefined`, not `failed`.** execa's `reject:false` sets `exitCode:undefined` when the binary can't spawn (ENOENT). For `nonzero-means-findings` kinds, a nonzero-but-defined exit code with stdout MUST be parsed; only `undefined` (spawn fail) or a thrown/aborted runner returns `[]`. Do NOT gate parse on `result.failed` for those kinds — `failed` is true on any nonzero exit, which would re-introduce G9.
- **Do NOT flip `semgrep` to `nonzero-means-findings`.** The sc-5-2 test at security-scanners.test.ts:252-273 asserts a nonzero semgrep yields `[]`. Only the 3 NEW kinds flip. Mention the `--error` convention in a comment only.
- **`.optional()` NO outer default on the 2 config objects** — an outer `.default({...})` would break BOTH deep-equal tripwires (schema.test.ts:641, :701). Copy the `diff:` line pattern exactly.
- **gitleaks JSON is a TOP-LEVEL ARRAY** — its parser's first guard is `if (!Array.isArray(json)) return []` (the INVERSE of npm-audit/osv which guard `!obj || typeof !== "object" || Array.isArray`). Don't copy the object-guard blindly.
- **Redact the gitleaks `Secret`** — use `Match` (or a masked value) in the finding snippet, never the raw live credential.
- **npm audit has TWO shapes** — v7+ `{vulnerabilities:{}}` and v6 `{advisories:{}}`. Support both (check which key is an object). Malformed → `[]`.
- **Network scanners gated on egress; gitleaks is offline.** `npm-audit`/`osv-scanner` require `egress.onlineResearch===true`; `gitleaks` (local secret scan) and the offline inspector run without egress. Tests keep egress OFF (nonGoals[2]) → network scanners are filtered out; assert they're skipped when egress is absent (sc-7-3).
- **Inspector is NOT a new LLM role** (ADR-4, nonGoals[3]) — it returns `SecurityFinding[]` folded into `effectivePriors`, rendered as the existing "ground truth priors" prompt section. Do not add a sub-auditor or a new `runAgenticLoop` call.
- **`auditDiff` may be `undefined`** (default `estimated-files` mode) — guard `auditDiff ? inspectSupplyChain(...) : []`. The inspector only has signal to work with when git-diff mode is on; that's acceptable (sc-7-5 tests inject a diff via `deps.diffProvider`).
- **Per-scanner + per-file isolation preserved** — one scanner ENOENT / one file read error → `[]` for THAT item only, never a rejection (sc-5-2, sc-7-4 "never throws"). Wrap each in its own try/catch.
- **Do not import from `src/discovery/`** — `src/discovery/scanners/package-scripts.ts` is an unrelated subsystem (research G5 line 119); building on it would couple two unrelated modules.
- **Keep the briefing's payload shapes exact** — the sc-7-2 evaluator table-tests each parser against a "representative real-shaped JSON payload"; use the shapes in §6, especially the osv `results[].packages[].vulnerabilities[]` nesting and the npm v7-vs-v6 branch.
