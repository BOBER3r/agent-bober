# Emit security audit findings into the priority hub

**Contract:** sprint-spec-20260712-security-audit-agent-team-6  ·  **Spec:** spec-20260712-security-audit-agent-team  ·  **Completed:** 2026-07-12

## What this sprint added

**Security audits now surface in the unified priority hub.** Through sprint 5 the `security.hub`
config key was declared-but-unconsumed. This sprint makes it live: a new pure mapper turns an
audit's confirmed `review.critical[]` / `review.important[]` findings into canonical hub `Finding`
objects and emits them via an injected sink — wired into **both** entry points (the fail-closed
pipeline gate and the standalone `bober security-audit` CLI) **after** the verdict/exit code is
already computed, guarded by `security.hub` (default `true`). `minor` and `approvedAreas` are never
emitted. Emission is strictly best-effort: a hub failure is caught and logged and can **never**
alter the audit verdict or exit code. The `FindingSchema` is imported from `src/hub/finding.ts`
(never redefined), and retry-idempotence is delegated to the hub's existing content-hash dedup —
proven against the **real** finding-store in a temp directory.

## Public surface

- `mapAuditToFindings(result: SecurityAuditResult, now: string): Finding[]`
  (`src/orchestrator/security-hub.ts:121`) — **pure** mapper (never reads the clock; `now` is
  injected). Emits one hub `Finding` per critical/important audit finding; clean audits return `[]`.
  Severity/urgency mapping: **critical → severity 5 / urgency 5**, **important → severity 3 /
  urgency 3** (read from the real `FindingSchema`, where both fields are `int().min(1).max(5)`).
  Each Finding uses `domain: "security"`, `kind: "risk"`, `status: "open"`, and tags
  `["security", "vuln:<vulnClass>"?, "stack:<stack>"]`.
- `emitSecurityFindings(result, sink, log, now): Promise<void>`
  (`src/orchestrator/security-hub.ts:146`) — best-effort emitter over an injected
  `SecurityFindingSink`; **never throws** (a throwing sink or mapping error is swallowed and
  `log.warn`'d).
- `SecurityFindingSink = (finding: Finding) => Promise<void>` (`security-hub.ts:29`) — the injected
  ingest seam (mirrors the research runner's `FindingSink` precedent).
- `SecurityGateInput.findingSink?` (`src/orchestrator/security-gate.ts:41`) — optional injected sink
  on the gate; when absent the gate binds `ingestFinding` to a lazily-opened default `FactStore`.
- `StandaloneAuditDeps.findingSink?` (`src/cli/commands/security-audit.ts:120`) — the same optional
  seam on the CLI, reusing the already-injected `deps.now` clock.

## How to use / how it fits

Hub emission is automatic and needs no new flags — it rides on the two existing audit entry points:

- **Pipeline gate** (`security.enabled === true`): after the verdict is computed and **outside** the
  `Promise.race` time-box, the gate maps the audit and ingests findings into the default pool
  (`.bober/memory/facts.db`) unless `security.hub` is `false`.
- **Standalone CLI** (`bober security-audit [target]`): same emission after the exit-code threshold
  is computed. The invocation is the opt-in, so an absent `security` section still emits (schema
  default `hub: true`).

Emitted findings then flow through the normal hub surface (`bober hub list` / `hub priority` /
`hub decide` / `bober chat hub`), deduped by the canonical `domain|title|kind` id. To silence
emission entirely:

```jsonc
"security": { "enabled": true, "hub": false }   // audits still run; zero hub writes
```

The `Finding.title` is deliberately **stable** — `[security] <vulnClass> at <path>:<line>` — with
no free-text description embedded, because the dedup id is `sha256(domain|title|kind)`; a
retry re-emits the identical title and the hub absorbs it as a no-op (or supersede). The audit's
free-text `description` and each `{path,line,snippet}` land in the Finding's `evidence: string[]`
(the schema has no `body` field and its `evidence` is a flat `string[]`, so evidence is flattened).

## Notes for maintainers

- **The whole default-sink sequence must live inside the guard (iteration-2 fix).** The first
  iteration guarded only the emission loop, leaving `ensureFactsDir` + `new FactStore` unguarded — an
  evaluator-reproduced `EEXIST` during store setup (a non-directory occupying `.bober/memory`)
  propagated as an unhandled rejection and **flipped a clean audit to blocked** (gate) / exit 2
  (CLI). The fix wraps `ensureFactsDir → new FactStore → emit → close` in a single
  `try/catch/finally` at both call sites (`security-gate.ts:189`, `security-audit.ts:223`), with
  regression tests reproducing the exact `mkdir`-EEXIST failure at both boundaries. When touching
  this code, keep any new fs setup **inside** that guard.
- **No hub imports in the auditor core.** `security-auditor-agent.ts` is untouched — the two callers
  wire emission in, keeping the core free of hub imports and preserving its `Promise.race`
  time-box. Do not import the hub into the core.
- **Lazy store, empty-check first.** The default sink checks `mapAuditToFindings(...).length === 0`
  **before** opening a `FactStore`, so a clean audit or `hub:false` never touches the filesystem.
- **Low advisory — `deriveFindingId` is now triplicated.** The `sha256(domain|title|kind)` id
  helper exists in three places: `src/hub/finding-store.ts:121` (the canonical, unexported one),
  `src/research/runner.ts:104`, and now `src/orchestrator/security-hub.ts:39`. Each is a local
  replica because the hub's copy is not exported (the research runner set this precedent). This is an
  **id hash, not a `FindingSchema` redefinition** (sc-6-4 grep-verified: no `z.object` in
  `security-hub.ts`, only a `import type { Finding }`). A future consolidation candidate: export one
  shared `deriveFindingId` from `src/hub/` and have both consumers import it. Left as-is this sprint
  (the spec forbids editing `src/hub/`).

## Scope

Iteration 1 (`5b9a214`, six files: new `security-hub.ts` + `security-hub.test.ts`, additive changes
to `security-gate.ts` / `security-audit.ts` and their tests) delivered the mapper, emitter, wiring,
and the real-store dedup test. Iteration 2 (`3d99fbc`, four files) applied the sc-6-2 guard-widening
fix plus two regression tests. `src/hub/` and `security-auditor-agent.ts` remained untouched
throughout. Full suite **4019 → 4045** green (+26 across both iterations). All five required criteria
(sc-6-1..6-5) passed at iteration 2.
