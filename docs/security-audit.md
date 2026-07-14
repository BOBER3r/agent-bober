# Security Audit

A stack-aware `bober-security-auditor` role finds exploitable vulnerabilities in
generated (or existing) code and reports them with cited evidence. Three surfaces
consume one shared core (`runSecurityAudit`, `src/orchestrator/security-auditor-agent.ts`):

- An **in-pipeline fail-closed gate** that can block a sprint from being marked
  `passed` on a critical finding.
- A **standalone `bober security-audit` CLI** for on-demand or CI-driven audits.
- The **`bober.security-audit` skill** — an advisory, conversational entry point that
  spawns the same auditor subagent (or points you at the CLI) outside a pipeline run.

The whole feature is **opt-in and default-off**: a project's `bober.config.json` that
omits the `security` key runs byte-identically to a project with no security auditor
at all — no gate branch executes, no scanner process spawns, no hub write happens.

---

## Quick Start

### CLI

```bash
bober security-audit [target]
# or: agent-bober security-audit [target]
```

Runs an on-demand stack-aware audit against a local path (or the working tree when
`target` is omitted). Uses the SAME `runSecurityAudit` core the in-pipeline gate uses
(with `evaluation=null` — standalone mode), persists a cited artifact to
`.bober/security/<id>-security-audit.md`, and prints a summary: verdict, per-bucket
finding counts, top findings as `path:line`, and the artifact path.

Does **not** require `security.enabled: true` — the explicit CLI invocation IS the
opt-in. The pipeline gate's separate critical-only veto is untouched by this command.

**Exit codes:**

| Code | Meaning |
|---|---|
| `0` | Pass — no findings at or above `security.standaloneBlockOn`. |
| `2` | Blocked — either the threshold (`security.standaloneBlockOn`) was tripped, or the audit failed closed (the audit threw, or the auditor's output could not be parsed). |
| `1` | Reserved for Commander's own usage errors / unexpected errors resolving config or the project root — not an audit outcome. |

`security.standaloneBlockOn` (`"critical"` by default, or `"important"`) controls
which findings trip exit code `2`:
- `"critical"` (default) — only `critical`-bucket findings block.
- `"important"` — `critical` **or** `important`-bucket findings block.

This threshold is CLI-local (`thresholdVerdict`, `src/cli/commands/security-audit.ts`)
and is intentionally never imported into the pipeline gate — the gate's own veto is
critical-only and does not read `standaloneBlockOn` at all.

After the exit code is computed, critical (hub severity/urgency `5`) and important
(`3`) findings are emitted into the priority hub (best-effort, guarded by
`security.hub`, default `true`; never changes the exit code), so they show up in
`bober hub list` / `bober hub priority`.

### Skill

Invoke the `bober.security-audit` skill (Claude Code slash command
`/bober-security-audit [target]` once distributed via `init`/`update-all`) for a
conversational audit. The skill spawns the `bober-security-auditor` subagent (agent
file `agents/bober-security-auditor.md`), presents findings ranked by severity with
`path:line` citations, persists the result to the same `.bober/security/` artifact
path the gate and CLI use, and reminds you that the skill run itself is **advisory
only** — it never blocks anything and never instructs writing code fixes. Enforcement
lives in the CLI's exit code and the pipeline gate below, not in the skill.

---

## Pipeline Gate

When `security.enabled === true`, `evaluateSecurityGate`
(`src/orchestrator/security-gate.ts`) runs automatically at the top of the pipeline's
`if (evaluation.passed)` branch — **before** a sprint is marked `passed`. It is a thin,
fail-closed wrapper over the shared `runSecurityAudit` core: it owns the
`Promise.race` time-box (`security.timeoutMs`), the error/timeout-to-reason mapping,
and a best-effort re-save of the artifact. It never re-derives the auditor's verdict
itself — the verdict comes straight from the core's `deriveVerdict` output.

### What blocks

| Reason | Trigger |
|---|---|
| `critical-finding` | The auditor's `review.critical` array is non-empty — a real, cited vulnerability. When the [verifier stage](#finder--verifier-stage) is enabled, this is the *verified* `review.critical` (post-fold); a critical the verifier disproves/downgrades no longer counts. |
| `timeout` | `runSecurityAudit` did not resolve within `security.timeoutMs`. |
| `audit-error` | `runSecurityAudit` rejected (thrown error), OR its output could not be parsed into a valid `ReviewResult` (`result.parsed === false`) — checked before `result.verdict` so a parse failure is never mistaken for a genuine critical finding. |

A gate that is `disabled` (`security` absent, or `enabled !== true`) never invokes the
audit at all — this is the fifth "reason" (`disabled`), and it is the value every
project without an opted-in `security` section gets.

### What happens on block

- The sprint is **not** marked `sprint-passed`.
- A `security-audit-blocked` history event is appended (phase `rework`), including the
  block reason, the critical-finding count, and up to 20 `{path, line, vulnClass?}`
  entries.
- Findings are rendered (`renderSecurityFeedback`) and routed into the **next
  generator iteration's** feedback — the same channel evaluator feedback uses — so the
  generator sees exactly which vulnerabilities to fix on retry.
- **Code review and the per-sprint documenter are skipped** for this iteration — they
  only run after a sprint reaches `passed`, and a security-blocked sprint never does.
- If the pipeline has exhausted `maxIterations`, the contract moves to
  `needs-rework` instead of retrying again.

### What happens on a clean audit

- A `security-audit-clean` history event is appended (phase `complete`).
- Critical/important findings are emitted to the priority hub per the hub-emission
  rules below (a "clean" verdict means `review.critical` is empty; `review.important`
  can still be non-empty on a clean audit, and those findings are still emitted).
- The pipeline falls through to the pre-existing `passed` logic unchanged.

### Byte-identical when unconfigured

When `security` is absent from `bober.config.json`, or present with `enabled` anything
other than exactly `true`, the entire gate branch is skipped — `runSprintCycle`
executes identically to a build of agent-bober with no security auditor at all. No
audit is invoked, no time-box is created, no history event beyond the pre-existing ones
is appended. This guarantee is what makes the feature safe to add to any existing
project's `bober.config.json` without a behavior change until the operator explicitly
sets `enabled: true`.

---

## Finder → verifier stage

When `security.verifier.enabled === true` (sprint 8, default off), the audit becomes a
two-stage **finder → verifier** pipeline — both stages inside the gate's single
`Promise.race` time-box:

1. **Finder** — the `bober-security-auditor` runs exactly as before and produces a
   `ReviewResult` with `critical`/`important`/`minor`/`approvedAreas` buckets.
2. **Verifier** — the `bober-security-verifier`
   (`src/orchestrator/security-verifier-agent.ts`) runs **sequentially after** the finder
   (never concurrently — its input *is* the finder's output). It is spawned in a **fresh,
   isolated context** fed **only** the finder's `critical`+`important` findings and the
   relevant diff hunks. It is told to **disprove** each finding and emits a JSON array of
   per-finding verdicts (`confirmed`/`downgraded`/`disproved`).
3. The verdicts are **folded** into the review (`foldVerifierResult`) and the **unchanged**
   `deriveVerdict` derives `pass`/`blocked` on the *verified* review.

The verifier exists to **control false positives** — the earlier sprints push recall up
(widened taxonomy, per-stack signatures, real diff, supply-chain axis), and because every
false positive is a hard sprint block, a stage that provably only *reduces* blocks (never
adds them) is what keeps that higher recall usable. Two properties make it safe:

- **The sprint contract is provably absent.** The verifier's user message deliberately
  excludes everything the finder is shown — no `# Sprint Contract` JSON, no
  `# Evaluation Result (Already Passed)` section, no priors. A favorably-worded contract
  ("here's what this sprint set out to build") is sycophancy bait that makes a reviewer
  wave real issues through; the verifier is a genuinely fresh second opinion precisely
  because it never sees that framing. It is also never shown `minor` or `approvedAreas`,
  so an approved area can never be re-opened.
- **Downgrade-only and fail-closed.** The verifier may only move a finding **down** —
  confirm (keep at original severity), downgrade (`critical`→`important`), or drop — never
  promote, add, or manufacture a clean pass; the folded `critical` set is always a strict
  subset of the finder's. And it is fail-closed: an unparseable/truncated response, a JSON
  *object* instead of an *array*, a provider error, a refusal, or an abort all resolve
  `ran:false`, which **keeps the finder's criticals unchanged** — a broken verification can
  never silently weaken a block. (A finding the verifier leaves unaddressed defaults to
  `verified` for the same reason.)

The net effect: a finder `critical` the verifier **disproves** stops blocking (verdict
flips `blocked`→`pass` for that finding), while a genuine `critical` the verifier
**confirms** still blocks. With `verifier` omitted, none of this runs and the audit is
single-stage — byte-identical to sprint 7.

---

## Configuration Reference

All fields live under the optional top-level `security` key
(`SecuritySectionSchema`, `src/config/schema.ts`). The whole section is `.optional()`
with **no** top-level default on `BoberConfigSchema` — omitting `security` entirely
means the parsed config has no `security` key at all (not `security: undefined`, but
the key itself absent), so nothing downstream can accidentally branch on a
materialized-but-disabled section.

| Field | Type | Default | Effect |
|---|---|---|---|
| `enabled` | `boolean` | `false` | The **pipeline** fail-closed gate runs only when this is exactly `true`. The standalone CLI does **not** require it — an explicit `bober security-audit` invocation is its own opt-in. |
| `failClosed` | `boolean` | `true` | Documents the fail-closed contract of the audit core: unparseable auditor output or a timeout is unconditionally treated as blocked, never a silent pass. The current gate/CLI implementation applies this behavior unconditionally rather than branching on the field's value. |
| `timeoutMs` | `number` (int > 0) | `300000` | Per-audit `Promise.race` time-box used by the pipeline gate. |
| `model` | `ModelChoice` (string) | `"opus"` | The model the `bober-security-auditor` subagent runs on. Accepts a shorthand (`"opus"`, `"sonnet"`) or a full provider-qualified model string. |
| `maxTurns` | `number` (int ≥ 1) | `20` | Maximum read-only tool-use turns the auditor gets (`Read`/`Grep`/`Glob` only — it has no `Write`/`Edit`/`Bash`). |
| `provider` | `string` (optional) | unset | Optional provider override for the auditor role. Not materialized when omitted. |
| `endpoint` | `string \| null` (optional) | unset | Optional custom base URL override (for openai-compatible endpoints). Not materialized when omitted. |
| `providerConfig` | `Record<string, unknown>` (optional) | unset | Optional provider-specific settings passed through to the adapter. Not materialized when omitted. |
| `budget` | `{ maxUsd: number }` (optional) | unset | Optional per-run USD spend ceiling for the audit. Not materialized when omitted. |
| `scanners` | `EvalStrategy[]` | `[]` | Opt-in deterministic scanner pre-filter (see "Scanners" below). Empty means zero child processes are spawned. |
| `standaloneBlockOn` | `"critical" \| "important"` | `"critical"` | CLI-only blocking threshold for `bober security-audit`'s exit code. The pipeline gate ignores this key entirely — its veto is always critical-only. |
| `hub` | `boolean` | `true` | Whether critical/important findings are emitted into the priority hub after the verdict is computed (see "Hub Emission" below). `false` means zero hub writes. |
| `diff` | `{ mode, baseRef?, expandWithGraph }` (optional) | unset | Opt-in real-diff provider (sprint 6). Omitted entirely ⇒ byte-identical to `estimated-files` behavior. See the sub-table below. |
| `supplyChain` | `{ enabled, scanners }` (optional) | unset | Opt-in supply-chain/dependency/secret axis (sprint 7). Omitted entirely ⇒ byte-identical (nothing runs). See the sub-table below. |
| `egress` | `{ onlineResearch }` (optional) | unset | Egress axis gating network-capable supply-chain scanners (sprint 7). Omitted entirely ⇒ byte-identical; network scanners stay off. See the sub-table below. |
| `verifier` | `{ enabled, model, maxTurns }` (optional) | unset | Opt-in adversarial **finder → verifier** stage (sprint 8) — a second read-only LLM pass that tries to *disprove* the finder's findings. Omitted entirely ⇒ byte-identical (single-stage audit). See the sub-table below. |

`provider`/`endpoint`/`providerConfig`/`budget`/`diff`/`supplyChain`/`egress`/`verifier` are the
only fields with **no** default — a config that sets `security: { enabled: true }` (or
any subset that omits these) parses without them present in the materialized object at
all; every other field always materializes to its default.

The optional `security.diff` object (`SecurityDiffConfigSchema`) has its own fields:

| Field | Type | Default | Effect |
|---|---|---|---|
| `mode` | `"estimated-files" \| "git-diff"` | `"estimated-files"` | `estimated-files` ranks signatures against the sprint's `estimatedFiles` scope (today's behavior). `git-diff` computes a **real** `AuditDiff` (changed files + hunks) via the orchestrator-owned `SecurityDiffProvider` and feeds the real hunks to the selector and the finder prompt. `git-diff` is **never** the default. |
| `baseRef` | `string` (optional) | unset | The git ref to diff against. When omitted, the provider resolves the merge-base with the detected default branch (`origin/HEAD` → `origin/main`/`master` → `main`/`master`), falling back to `HEAD~1`. |
| `expandWithGraph` | `boolean` | `false` | When `true` **and** the tokensave graph engine is `ready`, expands the changed files into a call-graph neighborhood (`GraphClient.impact`) surfaced to the finder. Ignored (empty neighborhood) when the graph is not ready. |

Even in `git-diff` mode the auditor toolset stays read-only — `git` runs only in
orchestrator Node ([ADR-5](../.bober/architecture/arch-20260714-security-auditor-per-stack-skills-adr-5.md)) —
and any git failure or an empty diff degrades to `estimated-files` behavior (never
throws, no regression).

The optional `security.supplyChain` object (`SecuritySupplyChainConfigSchema`, sprint 7)
turns on the supply-chain / dependency / secret axis:

| Field | Type | Default | Effect |
|---|---|---|---|
| `enabled` | `boolean` | `false` | When `true`, `runSecurityAudit` folds the supply-chain scanner pre-filter **and** the always-available offline diff inspector into the finder's priors. When `false`/omitted, none of the axis runs. |
| `scanners` | `EvalStrategy[]` | `[]` | Opt-in supply-chain scanner strategies, reusing the same `EvalStrategy` shape as `security.scanners`. `npm-audit`/`osv-scanner`/`gitleaks` are recognized by a `type`/`label`/`command` substring. Network-capable kinds (`npm-audit`/`osv-scanner`) run **only** when `egress.onlineResearch` is `true`; `gitleaks` (local) runs regardless. |

The offline **`SupplyChainDiffInspector`** (`src/orchestrator/security-knowledge/supply-chain-inspector.ts`)
runs whenever `supplyChain.enabled` and a real `AuditDiff` is present — **even with zero
scanners configured**. It is a pure, never-throwing, **zero-network, zero-`node:fs`** fold
over the diff's added lines and flags six patterns: obfuscated `package.json` lifecycle
scripts (`preinstall`/`install`/`postinstall`/`prepare` with base64/hex/eval/`child_process`/
`curl`/`wget`), a lockfile `resolved` host that is not a known registry, a `.npmrc` registry
override or `ignore-scripts=false`, a new dependency with no matching import in the diff, CI
using `npm install` instead of `npm ci`, and a GitHub Action pinned by tag/branch instead of a
full commit SHA.

The optional `security.egress` object (`SecurityEgressConfigSchema`, sprint 7) gates network:

| Field | Type | Default | Effect |
|---|---|---|---|
| `onlineResearch` | `boolean` | `false` | Fail-safe opt-in. Only when `true` are the network-capable supply-chain scanners (`npm-audit`/`osv-scanner`, which hit a remote registry / vulnerability DB) invoked. Default `false` keeps every supply-chain code path offline (the inspector and `gitleaks` never touch the network anyway). |

The optional `security.verifier` object (sprint 8) turns on the adversarial
**finder → verifier** stage (see [Finder → verifier stage](#finder--verifier-stage)):

| Field | Type | Default | Effect |
|---|---|---|---|
| `enabled` | `boolean` | `false` | When `true`, a second read-only LLM pass (`bober-security-verifier`) runs sequentially **after** the finder, in a fresh contract-free context, and is told to *disprove* each of the finder's `critical`+`important` findings. When `false`/omitted, the audit is single-stage — byte-identical to sprint 7. |
| `model` | `ModelChoice` (string) | `"opus"` | The model the verifier subagent runs on. Same shorthand/full-string forms as `security.model`. |
| `maxTurns` | `number` (int ≥ 1) | `10` | Maximum read-only tool-use turns for the verifier (`Read`/`Grep`/`Glob` only). Defaults **lower** than the finder's `20` — refutation of a bounded finding list needs fewer turns than the original audit. |

The verifier may only ever move a finding **down** (confirm → keep, downgrade →
`critical`→`important`, disprove → drop) — it can never promote, add, or manufacture a
finding, and it is **never shown** `minor`, `approvedAreas`, or the sprint contract. Any
parse-failure, provider error, refusal, or abort is **fail-closed** (`ran:false` ⇒ the
finder's criticals are kept unchanged), and the **unchanged** `deriveVerdict` runs on the
folded review.

**Annotated example** (mirrors the README's config-reference block):

```jsonc
"security": {                           // Optional. Omit entirely => byte-identical (no key, no defaults).
  "enabled": false,                     // Fail-closed pipeline gate runs ONLY when exactly true. NOT required by the standalone CLI.
  "failClosed": true,                   // Unparseable auditor output / timeout blocks. Default true.
  "timeoutMs": 300000,                  // Per-audit time-box (pipeline gate).
  "model": "opus",                      // Auditor model. Any model string or shorthand.
  "maxTurns": 20,                       // Max read-only tool-use turns for the audit.
  "standaloneBlockOn": "critical",      // CI threshold for `bober security-audit`: 'critical' | 'important'. Gate ignores this key.
  "scanners": [],                       // Opt-in deterministic pre-filter strategies (EvalStrategy[]). slither/semgrep JSON parsed into auditor priors; unknown scanners → raw-text excerpt. Nonzero exit ⇒ [] (use exit-0 commands). Empty ⇒ zero child processes.
  "hub": true,                          // Emit critical (severity 5) / important (severity 3) findings into the priority hub after the verdict (gate + CLI). Best-effort; false ⇒ zero hub writes. Never affects the verdict/exit code.
  "diff": {                             // Optional (sprint 6). Omit entirely => byte-identical estimated-files behavior. git runs ONLY in orchestrator Node (ADR-5) — auditor stays read-only.
    "mode": "estimated-files",          // 'git-diff' computes a real AuditDiff (60-file/256KB caps) and feeds the actual changed hunks to the selector + finder. Never the default; empty diff / git failure ⇒ estimated-files fallback.
    "expandWithGraph": false            // 'git-diff' only: when true AND the tokensave graph is ready, add a call-graph neighborhood. baseRef?: optional ref (default: merge-base w/ default branch, else HEAD~1).
  },
  "supplyChain": {                      // Optional (sprint 7). Omit entirely => the whole axis is off (byte-identical). Findings fold into the finder's priors (ADR-4), not a new LLM role.
    "enabled": false,                   // When true: fold the supply-chain scanner pre-filter + the always-available OFFLINE diff inspector (6 checks, zero network) into priors.
    "scanners": []                      // Supply-chain scanner EvalStrategy[] (npm-audit/osv-scanner/gitleaks, detected by substring). npm-audit/osv-scanner run ONLY when egress.onlineResearch=true; gitleaks (local) runs regardless.
  },
  "egress": {                           // Optional (sprint 7). Omit entirely => network scanners stay off (byte-identical).
    "onlineResearch": false             // Fail-safe opt-in. Only when true are the network-capable supply-chain scanners (npm-audit/osv-scanner) invoked. The offline inspector + gitleaks never touch the network.
  },
  "verifier": {                         // Optional (sprint 8). Omit entirely => single-stage audit (byte-identical). Adversarial finder->verifier stage. Downgrade-only + fail-closed.
    "enabled": false,                   // When true: after the finder, a fresh contract-free read-only pass tries to DISPROVE each critical/important finding. May only downgrade (critical->important) or drop; parse-failure/error/abort => criticals kept.
    "model": "opus",                    // Verifier model. Any model string or shorthand.
    "maxTurns": 10                      // Max read-only tool-use turns for the verifier (lower than the finder's 20 — refutation needs fewer turns).
  }
}
```

agent-bober's own `bober.config.json` opts into **LLM-only dogfooding**:

```jsonc
"security": { "enabled": true, "scanners": [] }
```

Every other field takes its schema default (`failClosed: true`, `timeoutMs: 300000`,
`model: "opus"`, `maxTurns: 20`, `standaloneBlockOn: "critical"`, `hub: true`) — so
every future sprint of this repository runs the fail-closed gate on LLM judgment
alone (no `slither`/`semgrep` binaries required on the dev machine).

---

## Scanners

`security.scanners` is an opt-in deterministic pre-filter
(`runScannerPreFilter`, `src/orchestrator/security-scanners.ts`, ADR-4). Each entry is
an `EvalStrategy` (`{ type, required, label?, command?, plugin?, config? }` —
`required` has no schema default, so it must always be supplied) whose
`type`/`label`/`command` is matched (case-insensitively, substring match) against
`"slither"` or `"semgrep"` to select a parser; anything else degrades to a bounded
raw-text excerpt so an unmapped tool still contributes *some* ground truth instead of
being silently dropped. `required` itself has no effect on the scanner pre-filter (it
is a passthrough field shared with the main `evaluator.strategies` shape) — a scanner
that fails contributes `[]` regardless of its `required` value.

Scanner findings are **advisory priors only** — they seed the auditor's prompt as
"deterministic scanner findings (ground truth priors)" that the LLM confirms with its
own read of the code and cites independently. They never bypass the LLM auditor and
never drive the verdict directly.

With `scanners: []` (the default, and what agent-bober's own dogfood config uses), no
child process is spawned at all — behavior is byte-identical to having no scanner
pre-filter.

**Slither** (Solidity static analyzer) — configure with the `--json` output flag so
the parser can read structured findings:

```jsonc
"scanners": [
  { "type": "slither", "command": "slither . --json -", "required": false }
]
```

**Semgrep** — also needs its `--json` flag:

```jsonc
"scanners": [
  { "type": "semgrep", "command": "semgrep --config auto --json .", "required": false }
]
```

Both parsers (`parseSlitherOutput` / `parseSemgrepOutput`) are pure and
fixture-tested — no binaries are required in CI to exercise the parsing logic itself,
only to actually run a live scan.

**Per-scanner isolation:** a missing binary (ENOENT), a thrown error, or an abort yields
`[]` for that scanner only and never affects the others or aborts the audit. Scanners run
under the shared audit `AbortSignal` with `killSignal: "SIGKILL"`, so an aborted/timed-out
scan cannot linger and partial findings from already-finished scanners are preserved.

**Exit-code convention (G9, sprint 7):** the handling of a *nonzero* exit is now
per-scanner-kind (`scannerExitPolicy`). For `slither`, the default `semgrep` invocation,
and any unrecognized kind (`"zero-clean"`), a nonzero/failed exit still discards the output
— so `semgrep --error` (whose own convention treats nonzero as "findings found") must still
be configured to exit `0`. For `npm-audit`/`osv-scanner`/`gitleaks` (`"nonzero-means-findings"`),
whose OWN convention is to exit nonzero precisely when they find something, the stdout is
parsed even on a nonzero-but-defined exit — only a genuine spawn failure (`exitCode` undefined:
ENOENT / could-not-spawn) is discarded. These three kinds are wired through the sprint-7
supply-chain axis (`security.supplyChain`, see the Configuration Reference); `semgrep` is left
`"zero-clean"` by design so the existing isolation behavior is unchanged.

---

## Hub Emission

After an audit's verdict (gate) or exit code (CLI) is already computed, both call
sites map the audit's confirmed findings into canonical priority-hub `Finding` rows
and ingest them into the default `FactStore` pool (`.bober/memory/facts.db`) via
`mapAuditToFindings` / `emitSecurityFindings` (`src/orchestrator/security-hub.ts`):

| Audit bucket | Hub severity | Hub urgency | Emitted? |
|---|---|---|---|
| `review.critical[]` | `5` (highest) | `5` | Yes |
| `review.important[]` | `3` (mid) | `3` | Yes |
| `review.minor[]` / `approvedAreas` | — | — | **Never** — the LLM auditor did not confirm these into a blocking or notable bucket. |

Each emitted `Finding`'s title is **stable**: `[security] <vulnClass> #<discriminator>
at <path>:<line>` (never the free-text description verbatim, which can vary across
retries) — this feeds the hub's existing content-hash id (`sha256(domain|title|kind)`),
so re-auditing the same vulnerability is idempotent rather than minting duplicate hub
rows.

The `#<discriminator>` segment fixes a title collision (**G10**): two **different**
vulnerabilities of the same `vulnClass` at the same `path:line` used to hash to the
**same** id and silently overwrite each other. The discriminator prefers the finding's
`signatureId`, then its `cwe`, then falls back to a short stable `sha256` of the
finding's own `description` — content-derived, so an identical retry (same description)
still resolves to the same discriminator and dedups, while two distinct findings diverge
into two hub rows. Structured metadata rides the existing `tags[]` when present
(`cwe:<id>`, `severity:<level>`, `confidence:<level>`, `sig:<signatureId>`) — the hub
`Finding` schema (`hub/finding.ts`) is unchanged.

Emission is gated by `security.hub` (default `true`; `false` means zero hub writes —
no `FactStore` is even opened) and is strictly **best-effort**: the entire default-sink
sequence (`ensureFactsDir` → open `FactStore` → emit → close) is wrapped in a single
guard at both call sites, so a hub/filesystem failure is caught and logged and can
**never** change the audit verdict or exit code. A clean audit (no critical/important
findings) or a `hub: false` config never even opens the store.

---

## Fail-Closed Guarantees

The feature is designed so an incomplete or malformed audit is never mistaken for a
clean one:

- **Unparseable auditor output** (`result.parsed === false`) always resolves to
  `verdict: "blocked"` inside the shared `runSecurityAudit` core, and the gate reports
  the distinct reason `audit-error` (not `critical-finding`) so callers/tests can tell
  the two failure modes apart.
- **A timeout** (`Promise.race` against `security.timeoutMs`) in the pipeline gate
  always resolves to `blocked: true, reason: "timeout"` — never a pass by omission.
- **A thrown error** anywhere in the audit core (provider failure, network error,
  budget exhaustion) is caught and mapped to `blocked: true, reason: "audit-error"` in
  the gate, and to exit code `2` with a stderr message in the CLI — never silently
  swallowed into a pass.
- **`evaluateSecurityGate` itself never throws.** Every failure mode resolves to a
  `SecurityGateVerdict` — there is no code path where a gate exception could propagate
  and crash the pipeline or leave a sprint in an undefined state.
- **The auditor subagent has no `Write`/`Edit`/`Bash` tools.** It cannot fix
  vulnerabilities, and it cannot fabricate a persisted artifact — persistence is
  always done by the orchestrating code (the gate, the CLI, or this skill), never by
  the subagent itself.

---

## Roadmap: per-stack signature libraries (in progress)

An in-progress upgrade (`spec-20260714-security-auditor-per-stack-skills`) is building a
registry of hand-authored, per-stack **security signature libraries** to give the auditor
concrete vulnerable/safe code exemplars per technology (Solidity, Anchor, React, Node,
payments, iGaming, DEX-backend, plus a shared `generic` OWASP/CWE library). Each library is
a `skills/bober.security-<stack>/SKILL.md` file of discrete labelled **signature blocks**
(`signatureId`, title, CWE, severity, `VulnClass`, invariant, unsafe/safe examples,
keywords), read by a pure, total `SecuritySignatureParser`
(`src/orchestrator/security-knowledge/`). As of the current sprints, the widened
taxonomy, the `SecuritySignature` type + parser, **all eight** authored libraries, **and
the retrieval pipeline that feeds them to the auditor** all exist and are tested:

- [`bober.security-generic`](../skills/bober.security-generic/SKILL.md) — shared OWASP/CWE library (14 blocks).
- [`bober.security-solidity`](../skills/bober.security-solidity/SKILL.md) — on-chain EVM contract signatures (12 blocks).
- [`bober.security-anchor`](../skills/bober.security-anchor/SKILL.md) — Solana/Anchor program signatures (7 blocks).
- [`bober.security-igaming`](../skills/bober.security-igaming/SKILL.md) — iGaming/betting-backend signatures (12 blocks).
- [`bober.security-dex-backend`](../skills/bober.security-dex-backend/SKILL.md) — crypto-exchange off-chain custody/backend signatures (12 blocks).
- [`bober.security-node`](../skills/bober.security-node/SKILL.md) — Node/Express backend signatures (12 blocks).
- [`bober.security-payments`](../skills/bober.security-payments/SKILL.md) — payments/PSP backend signatures (10 blocks).
- [`bober.security-react`](../skills/bober.security-react/SKILL.md) — React client-side signatures (8 blocks).

An enumeration test locks this exact 8-stack set (excluding `bober.security-audit`, the
audit *workflow* skill).

**As of sprint 5, these libraries are WIRED** — the auditor now retrieves per-stack
signatures at audit time via a four-stage pipeline under
`src/orchestrator/security-knowledge/`:

1. `SecurityStackRegistry.resolve` maps the project's declared/detected stack
   (`config.project.stack`) to one of the 8 stack ids + its skill name; an
   unknown/absent/null stack degrades to `generic` (never null, never a throw).
2. `SecurityKnowledgeIndex` parses all 8 `SKILL.md` files **once per process** (ADR-7 —
   no runtime cache invalidation; edit a skill file and restart to pick it up) and serves
   each stack's `SecuritySignature[]`.
3. `selectSignatures` ranks that stack's signatures top-K by stack membership + keyword/path
   overlap and **always** includes the shared `generic` floor.
4. `resolveStackSecurityContext` renders the selected signatures (id/title/CWE/invariant +
   unsafe/safe examples) into a **never-empty** prompt fragment that is folded into the
   finder's user message. This closes **G3**: `unknown`/`anchor`/`react` no longer inject
   frontmatter filler, and an unrecognised stack falls through to the generic floor.

By default, ranking scores against the sprint's `estimatedFiles` scope. **As of sprint 6, an
opt-in real git-diff mode exists** (`security.diff.mode: "git-diff"`, default `"estimated-files"`):
an orchestrator-owned `SecurityDiffProvider` shells `git` in orchestrator Node to compute the
actual changed files/hunks (bounded to 60 files / 256 KB, `truncated:true` past that; base ref =
explicit → merge-base with the detected default branch → `HEAD~1`), optionally expanded with a
tokensave call-graph neighborhood. Those real hunks then drive both the selector's
keyword/path ranking and a `# Changed files (real diff)` section rendered inline into the finder
prompt. The provider **never throws** — any git failure (no repo, no `git` binary, abort, malformed
output) degrades to an empty diff, which falls back to `estimatedFiles` behavior with no regression.
Crucially the auditor toolset stays read-only: **git runs only in orchestrator Node, never as an
auditor tool** ([ADR-5](../.bober/architecture/arch-20260714-security-auditor-per-stack-skills-adr-5.md)).
This closes **G4**.

**As of sprint 7 the supply-chain / dependency / secret axis exists** (`config.security.supplyChain`,
default off), closing **G5** and **G9**. A per-kind `scannerExitPolicy` fixes **G9**:
`npm-audit`/`osv-scanner`/`gitleaks` — whose own convention is to exit nonzero *precisely when they
find something* — now have their stdout parsed on a nonzero-but-defined exit (a genuine spawn failure
still yields `[]`), while `semgrep` stays `"zero-clean"`. Three new pure/total parsers
(`parseNpmAuditOutput`/`parseOsvOutput`/`parseGitleaksOutput`) map into `supply-chain` (or
`secret-handling` for gitleaks) findings. An always-available **offline `SupplyChainDiffInspector`**
(zero network, zero `node:fs`, never throws) folds six risk patterns over the diff — obfuscated
lifecycle scripts, lockfile host mismatch, `.npmrc` overrides, a new dep with no import, CI
`npm install` vs `npm ci`, and tag-vs-SHA-pinned GitHub Actions. All findings feed the finder's
priors (ADR-4 — not a new LLM role); network-capable scanners run only behind
`config.security.egress.onlineResearch` (default off).

**As of sprint 8 the fresh-context finding verifier is built** (`config.security.verifier`, default
off) — the **keystone false-positive control** that completes the spec's core feature set. It adds an
adversarial **finder → verifier** stage: a second read-only LLM pass
(`bober-security-verifier`) runs sequentially after the finder, in a fresh context fed **only** the
finder's `critical`+`important` findings and the diff hunks — **never the sprint contract** (the
sycophancy strip) — and is told to *disprove* each one. It is strictly **downgrade-only** (confirm /
`critical`→`important` / drop; never promote or re-open `approvedAreas`) and **fail-closed** (any
parse-failure/error/abort ⇒ the finder's criticals are kept), with the **unchanged** `deriveVerdict`
run on the folded review. See [Finder → verifier stage](#finder--verifier-stage) above.

**As of sprint 9, detection quality is measurable offline** — the finder→verifier pipeline's
effect is now *measured, not asserted* (architecture success criterion #3). A labelled
vulnerable/safe **benchmark corpus** (`src/orchestrator/security-knowledge/benchmark/fixtures/manifest.json`
— 13 vulnerable + 13 safe fixtures whose code is inlined as JSON strings, drawn verbatim from the
shipped skill unsafe/safe examples so nothing compiles) plus a pure, deterministic `measure()`
harness (`benchmark/harness.ts`) run a finder-only path versus a finder+verifier path over the
corpus and report **recall** on the vulnerable set (detection retained) and **false-positive block
rate** on the safe set. The required CI test drives the harness with deterministic injected fakes
(no live LLM, no network, no `Math.random`/`Date`) and independently recomputes the reduction —
`fpBlockRate` 2/13 → 0 while `recall` stays 1 → 1 — while a two-arm test grounds every vulnerable
label against the real parsed signature index (or the `ALL_VULN_CLASSES` union for the scanner-only
supply-chain case). It is a measurement + regression guard, **not** a new blocking gate, and is not
wired into `runSecurityAudit`; a documented, skipped-by-default block records how to run it against a
real provider locally. Only the dogfood/docs close-out remains. See the
[sprint records](./sprints/README.md) for the authoring format and per-sprint detail.

---

## FAQ

**What happens if the audit times out?**
The pipeline gate treats a timeout (`security.timeoutMs`, default 5 minutes)
identically to any other failure: `blocked: true, reason: "timeout"`. The sprint is
not marked passed, a `security-audit-blocked` history event is recorded, and the
generator's **next iteration** retries the sprint (this time without a prior audit
result to react to, since a timeout produces no findings to route into feedback —
`renderSecurityFeedback` returns a single generic "the security audit timed out"
message in that case). If the pipeline has exhausted `maxIterations`, the contract
moves to `needs-rework` instead.

**What happens if the audit exhausts its budget (`security.budget.maxUsd`)?**
A budget-exhaustion error from the provider layer surfaces as a thrown error from
`runSecurityAudit`, which the gate catches and maps to `blocked: true, reason:
"audit-error"` (same retry path as a timeout) and the CLI maps to exit code `2` with a
stderr message. Fail-closed applies here too — a budget-exhausted audit is never
treated as a silent pass.

**What if the auditor reports a false positive?**
There is an opt-in automated control: the [finder → verifier stage](#finder--verifier-stage)
(`security.verifier.enabled`, default off). When enabled, a second read-only LLM pass runs in a
fresh contract-free context, is told to *disprove* each `critical`/`important` finding against the
cited evidence, and can **downgrade** (`critical`→`important`) or **drop** a finding it disproves —
so a false-positive critical stops blocking without any human intervention. It is downgrade-only and
fail-closed, so it can only ever *reduce* blocks, never add them.

Beyond that, the gate itself has no per-finding dispute mechanism — with the verifier off (or for a
critical the verifier confirms), a critical finding blocks regardless of confidence. The retry path
is the same as any other block: the generator sees the finding's `path:line` evidence in its next
iteration's feedback and can either fix the flagged code or (if truly a false
positive) leave a `bober:` ceiling-style comment documenting why the pattern is safe,
which the auditor's "what NOT to flag" guidance already treats as an intentional,
auditable trade-off on a subsequent pass rather than an oversight. There is no
override flag that skips the gate for a single finding — disabling `security.enabled`
disables the gate for the whole project, not per-finding.

**Do I need `slither`/`semgrep` installed to use this feature?**
No. `security.scanners` defaults to `[]` (and agent-bober's own dogfood config keeps
it that way), which means the audit runs on LLM judgment alone with zero child
processes spawned. Scanners are a purely additive, opt-in ground-truth layer.
