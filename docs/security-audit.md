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
| `critical-finding` | The auditor's `review.critical` array is non-empty — a real, cited vulnerability. |
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

`provider`/`endpoint`/`providerConfig`/`budget` are the only fields with **no**
default — a config that sets `security: { enabled: true }` (or any subset that omits
these four) parses without them present in the materialized object at all; every
other field always materializes to its default.

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
  "hub": true                           // Emit critical (severity 5) / important (severity 3) findings into the priority hub after the verdict (gate + CLI). Best-effort; false ⇒ zero hub writes. Never affects the verdict/exit code.
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

**Per-scanner isolation:** a missing binary, a thrown error, or **any** nonzero exit
code yields `[]` for that scanner only and never affects the others or aborts the
audit. This means tools whose own convention treats nonzero exit as "findings found"
(e.g. `semgrep --error`) must be configured to exit `0` — otherwise their output is
silently discarded rather than parsed. Scanners run under the shared audit
`AbortSignal` with `killSignal: "SIGKILL"`, so an aborted/timed-out scan cannot linger
and partial findings from already-finished scanners are preserved.

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
(`src/orchestrator/security-knowledge/`). As of the foundation sprints, the widened
taxonomy, the `SecuritySignature` type + parser, and the first
[`bober.security-generic`](../skills/bober.security-generic/SKILL.md) library exist and
are tested, **but are not yet wired into `runSecurityAudit`** — the audit behavior described
above is unchanged until the index/selector sprint lands. See the
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
The auditor is advisory in the sense that a human (or a subsequent generator
iteration) can dispute a finding, but the gate itself has no dispute mechanism — a
critical finding blocks regardless of confidence. The retry path is the same as any
other block: the generator sees the finding's `path:line` evidence in its next
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
