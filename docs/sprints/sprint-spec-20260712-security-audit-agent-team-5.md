# Implement the scanner pre-filter with slither and semgrep parsers

**Contract:** sprint-spec-20260712-security-audit-agent-team-5  ·  **Spec:** spec-20260712-security-audit-agent-team  ·  **Completed:** 2026-07-12

## What this sprint added

**Deterministic ground truth for the LLM auditor.** Sprints 1–4 built the schema, the callable
`runSecurityAudit` core, the fail-closed pipeline gate, and the standalone CLI — but the `security.scanners`
config key was still declared-but-unconsumed. This sprint makes it live: a new
`src/orchestrator/security-scanners.ts` runs each configured scanner command (via `execa`) under the shared
audit `AbortSignal`, parses **slither** and **semgrep** JSON output into typed `SecurityFinding[]` priors
(fixture-tested; **no binaries required in CI**), degrades any other scanner to a bounded raw-text excerpt
finding, and folds the result into `runSecurityAudit`'s existing `priors` seam so the auditor prompt now
opens with a deterministic ground-truth section. Every scanner is isolated (missing binary / nonzero exit /
thrown error → `[]` for that scanner only); the pre-filter **never rejects** and SIGKILLs its children when
the shared signal fires (partial findings survive, no hang). Per ADR-4, an **absent or empty**
`security.scanners` remains a pure LLM pass with **zero child processes** and behavior byte-identical to
sprint 2.

## Public surface

- `runScannerPreFilter(input: ScannerPreFilterInput): Promise<SecurityFinding[]>`
  (`src/orchestrator/security-scanners.ts:316`) — runs every configured scanner in parallel and returns the
  flattened priors. `scanners: []` is a structural no-op (no runner invoked, nothing spawned). Never rejects;
  per-scanner failures are swallowed to `[]` in `runOneScanner`.
- `parseSlitherOutput(json: unknown): SecurityFinding[]` (`security-scanners.ts:128`) — **pure**, defensive
  narrowing at every level (`results.detectors[] → elements[].source_mapping`); truncated / valid-JSON-wrong-shape
  input returns `[]`, never throws. Encodes slither's `impact` bucket as a `[High]`-style description prefix
  and stamps `source: "slither"`.
- `parseSemgrepOutput(json: unknown): SecurityFinding[]` (`security-scanners.ts:198`) — **pure**, same
  contract for semgrep's `results[]` shape (`check_id`, `path`, `start.line`, `extra.severity/message`);
  `[ERROR]/[WARNING]/[INFO]` description prefix, `source: "semgrep"`.
- `ScannerRunner` (`security-scanners.ts:36`) & `ScannerRunResult` (`:23`) — the injectable child-process
  seam. The default implementation wraps `execa` with `cancelSignal`, `killSignal: "SIGKILL"`,
  `reject: false`, and `maxBuffer: 10 MB`; tests inject a fake for CI-offline coverage.
- `ScannerPreFilterInput` (`security-scanners.ts:296`) — `{ scanners: EvalStrategy[]; projectRoot: string;
  signal: AbortSignal; runner?: ScannerRunner }`.
- `runSecurityAudit(...)` (`src/orchestrator/security-auditor-agent.ts`) — **signature unchanged**. Now
  internally calls `runScannerPreFilter` when `config.security.scanners` is non-empty, under its own
  `AbortController` keyed to `security.timeoutMs`, and concatenates the scanner findings onto any
  caller-supplied `priors`. `scannerRan` is now `configuredScanners.length > 0 || effectivePriors.length > 0`.

## How to use / how it fits

Scanner entries reuse the existing `EvalStrategy` shape (from `security.scanners: EvalStrategySchema[]`).
Parser selection is name/command-based: a `slither` or `semgrep` substring anywhere in the strategy's
`type` / `label` / `command` picks the matching parser; anything else falls back to a raw-text excerpt.

```jsonc
// bober.config.json — opt-in scanner pre-filter
"security": {
  "enabled": true,
  "timeoutMs": 300000,
  "scanners": [
    { "type": "slither", "command": "slither . --json -", "required": false, "label": "slither" },
    { "type": "semgrep", "command": "semgrep --config auto --json", "required": false, "label": "semgrep" }
  ]
}
```

When configured, both the in-pipeline gate and the standalone `bober security-audit` inherit the priors for
free through the shared core — no gate or CLI change was needed (they call `runSecurityAudit`, whose
signature did not change). Scanner findings are **advisory priors only**: they seed the auditor prompt's
ground-truth section but never bypass the LLM or drive the verdict directly (the review buckets remain the
verdict source, per nonGoals).

## Notes for maintainers

- **Nonzero exit ⇒ `[]` (documented ceiling).** ANY nonzero exit code (or `execa` `failed`) yields `[]` for
  that scanner — even for tools whose own convention treats nonzero as "findings present" (e.g.
  `semgrep --error`). Operators wiring such a scanner **must configure an exit-0 command** so findings still
  flow. Flagged inline as a `bober:` comment at `security-scanners.ts:350`; revisit per-scanner exit-code
  conventions if this proves too coarse.
- **`vulnClass` is inferred, never fabricated.** `inferVulnClass` (`security-scanners.ts:90`) keyword-matches
  a check/rule id to one of the six `VulnClass` values and returns `undefined` when nothing cleanly maps
  (e.g. slither `reentrancy-eth` has no clean home and is intentionally left unset — forcing a wrong class is
  worse than none).
- **Time-boxing is SIGKILL, no grace period.** `killSignal: "SIGKILL"` means both `.kill()` and a
  `cancelSignal`-triggered termination go straight to SIGKILL so an aborted scan cannot linger. Verified with
  a real long-running `node -e` child, killed in ~100–300 ms.
- **Two low advisories left as-is (not fixed).** The evaluator noted (1) the `scannerRan` doc-comment in
  `security-audit-types.ts:37` is now imprecise — it also reads `true` from caller-priors-only, a
  contract-sanctioned backward-compat formula (doc-only follow-up); and (2) severity is conveyed as
  `[High]`/`[ERROR]` **description prefixes** rather than a structured field, because `ReviewFinding` is
  locked and has no severity/bucket field. Both are defensible, awareness-only.
- **Hub emission is the last remaining unwired key.** After this sprint the only declared-but-unconsumed
  `security` key is `hub` (sprint 6); a skill wrapper lands in sprint 7.

## Scope

Iteration 1 (single commit) — `bf2a31b` — exactly six intended files: new
`src/orchestrator/security-scanners.ts` (+369) and `security-scanners.test.ts` (+287), two committed
fixtures under `src/orchestrator/__fixtures__/` (`slither-sample.json`, `semgrep-sample.json`), and additive
changes to `src/orchestrator/security-auditor-agent.ts` (+50/-4, signature unchanged) plus
`security-auditor-agent.test.ts` (+3 wiring tests via module mock; no existing tests modified). `package.json`,
`security-gate.ts`, `pipeline.ts`, and the CLI are untouched. CI-offline empirically proven (slither/semgrep
binaries absent on the eval machine). Full suite **4004 → 4019** green (+15). All five required criteria
(sc-5-1..5-5) passed iteration 1.
