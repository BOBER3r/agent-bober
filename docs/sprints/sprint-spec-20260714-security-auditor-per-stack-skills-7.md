# Supply-chain axis: scanner kinds + nonzero-exit fix (G9) + offline diff inspector (G5)

**Contract:** sprint-spec-20260714-security-auditor-per-stack-skills-7  ·  **Spec:** spec-20260714-security-auditor-per-stack-skills  ·  **Completed:** 2026-07-14

## What this sprint added

This sprint adds the **supply-chain / dependency / secret axis** to the security audit. It does three things. First, it **fixes G9**: scanners whose own convention is to exit nonzero *precisely when they find something* (`npm audit`, `osv-scanner`, `gitleaks`) had their output silently discarded by the sprint-5 "any nonzero exit ⇒ `[]`" rule; a new per-kind `scannerExitPolicy` now parses their stdout on a nonzero-but-defined exit while still returning `[]` on a genuine spawn failure (ENOENT / abort / thrown). Second, it adds three new pure, total scanner parsers (`parseNpmAuditOutput`, `parseOsvOutput`, `parseGitleaksOutput`). Third, it introduces an **always-available OFFLINE `SupplyChainDiffInspector`** that flags six supply-chain risk patterns over the real diff with **zero network and zero `node:fs` reads** — a pure fold over the hunk text the diff provider already captured.

All of it is **default-off** and **network-gated**: the axis runs only when `config.security.supplyChain.enabled`, and the network-capable scanners (`npm-audit`/`osv-scanner`) run only when `config.security.egress.onlineResearch` is explicitly `true`. Findings fold into the finder's **priors** alongside the existing scanner priors (ADR-4) — this is **not** a new LLM role or sub-auditor. This closes **G5** (no supply-chain coverage) and **G9** (nonzero-exit discard).

## Public surface

**New parsers + exit policy** (`src/orchestrator/security-scanners.ts`):

- `parseNpmAuditOutput(json)` (`security-scanners.ts:267`) — parses `npm audit --json`. Handles both the v7+ `{ vulnerabilities: { <pkg>: {...} } }` shape (including the mixed string/object `via` array) and the v6 `{ advisories: { <id>: {...} } }` fallback. Pure, total (malformed ⇒ `[]`), `vulnClass: "supply-chain"`.
- `parseOsvOutput(json)` (`security-scanners.ts:341`) — parses `osv-scanner --format json` (`{ results: [{ source, packages: [{ package, vulnerabilities }] }] }`). Pure, total, `vulnClass: "supply-chain"`.
- `parseGitleaksOutput(json)` (`security-scanners.ts:396`) — parses the gitleaks JSON report (a **top-level array** of `{ Description, File, StartLine, RuleID, Secret, Match }`). **The raw `Secret` field is never echoed into a finding** — `Match` (or a `(redacted)` placeholder) is used for the evidence snippet. Pure, total, `vulnClass: "secret-handling"`.
- `isNetworkScanner(scanner)` (`security-scanners.ts:530`, exported) — `true` for `npm-audit`/`osv-scanner`, `false` for the local `gitleaks` scan. Used by the auditor agent to gate network scanners behind the egress axis.
- `scannerExitPolicy(kind)` (`security-scanners.ts:517`, internal) — returns `"nonzero-means-findings"` for `npm-audit`/`osv-scanner`/`gitleaks`, `"zero-clean"` for everything else (semgrep, slither, unknown). `detectScannerKind` (`security-scanners.ts:458`) recognizes the three new kinds by a `type`/`label`/`command` substring (the longer `"osv-scanner"` literal is checked before the bare `"osv"` so `osv-scanner --format json` matches unambiguously).

**New offline inspector** (`src/orchestrator/security-knowledge/supply-chain-inspector.ts`):

- `inspectSupplyChain({ projectRoot, diff, signal })` (`supply-chain-inspector.ts:267`) — runs all six offline checks over `diff.changedFiles` and returns `SecurityFinding[]` (`vulnClass: "supply-chain"`, `source: "supply-chain-inspector"`). A pure fold over hunk text: **no `node:fs` reads, no child processes, no network**. Honours `signal.aborted` between files and **never throws** — a per-file check exception is logged at debug and skips that file only.
- `SupplyChainInspectInput` (`supply-chain-inspector.ts:21`) — the input shape `{ projectRoot, diff: AuditDiff, signal: AbortSignal }`. Consumes the shared `AuditDiff` that sprint 6 introduced.

**New config** (`src/config/schema.ts`):

- `config.security.supplyChain` (`SecuritySupplyChainConfigSchema`, `schema.ts:229`) — **optional** object `{ enabled: boolean (default false), scanners: EvalStrategy[] (default []) }`. `scanners` reuses `EvalStrategySchema` (same shape as `security.scanners`), so the supply-chain parser kinds are detected exactly like any other scanner.
- `config.security.egress` (`SecurityEgressConfigSchema`, `schema.ts:241`) — **optional** object `{ onlineResearch: boolean (default false) }`. Gates network-capable supply-chain scanners; mirrors the research/medical online-research egress precedent.
- Both are `.optional()` with **no outer default** — a config that omits `supplyChain`/`egress` parses byte-identically (no key materializes), the same guarantee as `security.diff`.

## The six offline checks

Each check inspects only the **added** lines of the changed hunks (via `addedLines`), scoped by filename:

1. **Malicious lifecycle script** — a `package.json` added/changed `preinstall`/`install`/`postinstall`/`prepare` script whose content matches an obfuscation pattern (`base64`/`eval(`/`atob(`/`child_process`/`curl`/`wget`/`node -e`/hex escapes) or contains a long base64-ish blob (≥80 chars).
2. **Lockfile host mismatch** — a `resolved` URL in `package-lock.json`/`yarn.lock`/`pnpm-lock.yaml` whose host is not a known registry (`registry.npmjs.org`/`registry.yarnpkg.com`).
3. **`.npmrc` risk** — a custom `registry=` (or scoped `@scope:registry=`) override, or `ignore-scripts=false` re-enabling lifecycle scripts.
4. **New dependency with no import** — a new dependency entry in `package.json` (a `"name": "^1.2.3"` semver-range line, skipping the metadata-key allowlist) with no matching `from "<dep>"` / `require("<dep>")` in any other changed file's added lines. Heuristic — flagged as possibly a false positive if the import lives outside the diffed hunks.
5. **CI uses `npm install`** — a `.github/workflows/*.yml` step running `npm install` instead of the reproducible, lockfile-enforcing `npm ci`.
6. **GitHub Action pinned by tag/branch** — a `uses: owner/action@<ref>` where `<ref>` is not a full 40-char commit SHA (supply-chain-tampering risk, cf. the tj-actions CVE-2025-30066).

The patterns are cheap substring/regex heuristics over added lines (mirroring `diff-provider.ts`'s `extractDiffKeywords`), not a JSON/YAML grammar — good enough to ground the finder's priors, not a guarantee of zero false positives/negatives.

## How it fits

`runSecurityAudit` (`security-auditor-agent.ts`) grew one additive seam after the sprint-6 diff computation and before building the user message. When `supplyChain.enabled`:

1. A fresh `AbortController` is time-boxed by `security.timeoutMs` (default 300 s).
2. The configured `supplyChain.scanners` are filtered: with `egress.onlineResearch !== true`, `isNetworkScanner` entries (`npm-audit`/`osv-scanner`) are dropped; `gitleaks` (local) and the offline inspector run regardless. The surviving scanners feed `runScannerPreFilter`.
3. The offline `inspectSupplyChain` runs whenever a real `AuditDiff` is present — **even when zero external scanners are configured**; it is the "always-available" half of the axis.
4. Both scanner priors and inspector findings are appended to `effectivePriors`, which then seeds the finder prompt as ground-truth priors.

With `supplyChain` absent, none of this executes and the audit is byte-identical to sprint 6. Because the offline inspector consumes the sprint-6 `AuditDiff`, it produces findings when `security.diff.mode` is `"git-diff"` (or a diff is otherwise provided); with no diff it contributes nothing rather than shelling git itself.

The **G9 fix** lives in `runOneScanner`: a spawn failure (`result.exitCode === undefined`) is still unconditionally discarded, but a defined nonzero exit is now discarded only when `scannerExitPolicy(kind) === "zero-clean"`. Semgrep stays `"zero-clean"` by design — flipping it would break the sprint-5 sc-5-2 isolation test that asserts a nonzero semgrep exit yields no findings.

## Notes for maintainers

- **G9 is scoped, not global.** Only the three named kinds parse-on-nonzero. `semgrep --error` (which shares the nonzero-on-findings convention) is intentionally left `"zero-clean"`; operators who want its findings must still configure it to exit `0`. The `docs/security-audit.md` "Scanners" isolation note reflects this.
- **The inspector never reads the filesystem.** All six checks operate purely on the hunk text already in `diff.changedFiles` (Pattern B). This is what makes "zero network / zero fs" provable and keeps the inspector total — do not add a `node:fs` read here without revisiting that guarantee.
- **Secrets are never echoed.** `parseGitleaksOutput` deliberately uses `Match`, never the raw `Secret`. Keep it that way — the finding is written to disk and surfaced in prompts.
- **Findings are priors, not a verdict.** Per ADR-4 the whole axis feeds the finder's priors; it does not add an LLM sub-auditor and does not drive the verdict directly. The LLM still confirms and cites independently.
- **Egress default is fail-safe.** `egress.onlineResearch` defaults `false`; no test in the suite makes a network call (offline inspector + injected runners only).
- **The verifier (sprint 8) is the last major feature pending.** It consumes the same `AuditDiff` and closes out the spec.

## Scope

One commit — `89d0ad7` (`bober(sprint-7): supply-chain scanner kinds + nonzero-exit fix (G9) + offline diff inspector (G5)`). Adds `supply-chain-inspector.ts` (+ `.test.ts`) under `src/orchestrator/security-knowledge/`; adds the three parsers + `scannerExitPolicy` + `isNetworkScanner` + the G9 branch to `security-scanners.ts` (+ test); adds `SecuritySupplyChainConfigSchema` + `SecurityEgressConfigSchema` + `security.supplyChain`/`security.egress` to `src/config/schema.ts` (+ test); folds both prior sources into `effectivePriors` in `security-auditor-agent.ts` (+ test). 1506 insertions / 18 deletions across 8 files. All 6 required criteria (sc-7-1..7-6) passed on iteration 1; typecheck, build, lint, and the full suite (320 files / **4227 tests**) green. G5 and G9 closed.
