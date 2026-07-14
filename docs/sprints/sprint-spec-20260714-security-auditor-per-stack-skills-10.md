# Dogfood enablement + docs + `.claude` sync (spec close-out, 10/10)

**Contract:** sprint-spec-20260714-security-auditor-per-stack-skills-10  ·  **Spec:** spec-20260714-security-auditor-per-stack-skills  ·  **Completed:** 2026-07-14

## What this sprint added

The final sprint of the pentest-grade upgrade turns the new pipeline **on for this repository** and documents it — no runtime component changed. This repo's own `bober.config.json` now opts into the full pipeline that sprints 1–9 built: the finder→verifier stage, the offline supply-chain axis, real git-diff grounding, and per-stack signature retrieval resolved to a **real** stack (not the generic floor). Network egress stays off, so every future sprint here is self-audited by the new pipeline without ever making an outbound request.

Concretely, `project.stack` is now declared as `{ "language": "typescript", "backend": "node" }`, which `SecurityStackRegistry.resolve` maps to the `node` stack — so the auditor is grounded in the real `bober.security-node` signature library plus the shared `generic` floor rather than generic prose. The `security` block gained `diff.mode: "git-diff"`, `supplyChain.enabled: true`, `egress.onlineResearch: false`, and `verifier.enabled: true`. The mandatory repo-config snapshot test was updated in lockstep so the parse stays byte-exact, `docs/security-audit.md` + the `bober.security-audit` skill + the auditor/verifier agent docs were consolidated to describe the shipped capability, `update-all` synced the new verifier agent and the 8 per-stack security skills into the `.claude` copies, and an offline, no-live-LLM constructability smoke was added.

## Public surface

This sprint is config + docs + sync — it adds **no new code symbols**. The load-bearing changes are configuration keys now set on this repo and the docs that describe them.

**`bober.config.json` (this repo now dogfoods the full pipeline):**

- `project.stack` = `{ language: "typescript", backend: "node" }` — resolves via `SecurityStackRegistry.resolve` to `stackId: "node"` / `skillName: "bober.security-node"`, so audits use the real node signature library.
- `security.diff` = `{ mode: "git-diff" }` — the auditor is grounded in the real changed hunks (`# Changed files (real diff)` section) rather than `estimatedFiles`.
- `security.supplyChain` = `{ enabled: true }` — the always-available offline supply-chain diff inspector folds dependency/lockfile/CI-risk priors into the finder.
- `security.egress` = `{ onlineResearch: false }` — network scanners stay off; only the offline inspector runs (nonGoal guard).
- `security.verifier` = `{ enabled: true }` — the fresh-context, downgrade-only finder→verifier stage re-checks critical/important findings.
- Every unset field takes its schema default: `failClosed: true`, `timeoutMs: 300000`, `model: "opus"`, `maxTurns: 20`, `standaloneBlockOn: "critical"`, `hub: true`, `scanners: []`, `diff.expandWithGraph: false`, `supplyChain.scanners: []`, `verifier.model: "opus"`, `verifier.maxTurns: 10`.

**Docs consolidated (describe the whole shipped pipeline, no phantom keys):**

- `docs/security-audit.md` — the "Roadmap: per-stack signature libraries (in progress)" section became "**Per-stack signature libraries (shipped)**"; new subsections document the **17-class `VulnClass` taxonomy + structured finding metadata** and **how to add or edit a signature** (the `### <stack>.<short-name>` block shape, drop-on-malformed parse, per-process memoisation). The dogfood config snippet was updated from the old `{ enabled: true, scanners: [] }` LLM-only form to the full-pipeline block. It explicitly records that `resolveStackSecurityContext` accepts a `threatModelText` **call parameter** and that there is **no `security.threatModelPath` config field** (correcting a stray reference in the contract's criterion text).
- `skills/bober.security-audit/SKILL.md` — a "full pipeline this skill orchestrates" section (per-stack retrieval, finder→verifier, supply-chain axis) plus new config-key notes (`project.stack`, `verifier.enabled`, `supplyChain.enabled`/`egress.onlineResearch`, `diff.mode`).
- `agents/bober-security-auditor.md` — describes the **retrieved** `# Stack Security Context` (never a raw skill excerpt), the real-diff `# Changed files` section, the widened 17-class taxonomy, the structured JSON finding fields (`cwe`/`severity`/`confidence`/`signatureId`), and a "Downstream Verification" section pointing at `agents/bober-security-verifier.md`.

**`.claude` sync (distribution copies, mechanically synced — not authored here):**

- `.claude/agents/bober-security-verifier.md` (new) + updated `.claude/agents/bober-security-auditor.md`.
- The 8 per-stack security skills as slash commands: `.claude/commands/bober-security-{generic,node,react,solidity,anchor,dex-backend,igaming,payments}.md` (new) + updated `.claude/commands/bober-security-audit.md`.

**New test:** `src/orchestrator/security-knowledge/dogfood-smoke.test.ts` — an offline constructability smoke (see below). `src/config/schema.test.ts`'s repo-config byte-identity snapshot was extended to the new `project.stack` + `security` fields.

## How to use / how it fits

Because this repo's config now enables the pipeline, no action is required to benefit from it — every future sprint of agent-bober is audited by the finder→verifier + offline supply-chain pipeline against the real `bober.security-node` signatures, and blocked fail-closed on an unrefuted critical finding. To flip it off, remove or set `false` on the `security.verifier.enabled` / `security.supplyChain.enabled` flags; to re-ground the audit on a different stack, change `project.stack`.

The offline constructability smoke (`dogfood-smoke.test.ts`) is the sprint's proof that the enabled config is wired end to end **without a live provider call**. It parses the real `bober.config.json` and asserts (a) the four new flags are set with egress off, (b) `SecurityStackRegistry.resolve(project.stack)` returns the `node` stack with `skillName: "bober.security-node"`, (c) `resolveStackSecurityContext` builds a non-empty node-stack `promptFragment` from the real on-disk skill index, and (d) `runSecurityVerifier.verify({ findings: [], ... })` constructs and returns `{ verified: [], downgraded: [], dropped: [], ran: true }` — it short-circuits on the empty finding list (`security-verifier-agent.ts`), so the smoke never touches the network or an LLM. It mirrors the "build-dist child-process smoke" lesson from the medical-import sax interop bug.

## The `.claude` sync command for this repo

This repo is **not** registered in `scripts/sync-targets.json` (only the solex demo paths are), so a bare `npm run update-all` does not touch it. The documented sync command that copied the verifier agent + 8 security skills into `.claude/` here is:

```bash
node scripts/update-all.mjs --skills-only /Users/bober4ik/agent-bober-workspace/agent-bober
```

The smoke test asserts the ready-to-sync **source** files always exist (`agents/bober-security-verifier.md`, `skills/bober.security-node/SKILL.md`, `skills/bober.security-generic/SKILL.md`) and, if any `.claude` synced file is present, that all of them are present together — so the filesystem is the single source of truth for whether the sync has run, without making the suite depend on it.

## Notes for maintainers

- **This sprint changed zero runtime behavior.** It is config + docs + sync only (a nonGoal was "do not change any runtime component behavior"). The single test-file edit outside the new smoke is the repo-config snapshot repair, which is mandatory when `bober.config.json` changes.
- **Network stays off.** `egress.onlineResearch: false` is a hard nonGoal for the dogfood; the offline supply-chain inspector runs but no network scanner does. The smoke test asserts this flag explicitly as a guard.
- **Deferred follow-ups carried from earlier sprints (non-blocking):** the solidity library's frontmatter claims cross-function reentrancy but ships only single-function + read-only blocks (sprint 3 nit); `node.orm-raw-escape-hatch` has no distinct NoSQL (`$where`/Mongo) example (sprint 4 nit). Neither affects this sprint.
- **No live end-to-end audit ran in CI.** By nonGoal, only the offline constructability smoke ran — a real audit against a provider on this repo's config is a manual/local step (there is a `BOBER_BENCHMARK_LIVE=1` skipped harness path from sprint 9 for the corpus, and the standalone `bober security-audit` CLI for an ad-hoc run).

## Scope

One commit — `d934df6` (`bober(sprint-10): dogfood verifier + offline supply-chain, docs, and .claude sync`). 17 files, +2577/−41: `bober.config.json`, `docs/security-audit.md`, `skills/bober.security-audit/SKILL.md`, `agents/bober-security-auditor.md`, the updated `src/config/schema.test.ts` snapshot, the new `src/orchestrator/security-knowledge/dogfood-smoke.test.ts`, and the mechanically-synced `.claude/` agent + 8 skill-command copies. All 5 required criteria (sc-10-1..10-5) passed on iteration 1: config dogfoods verifier + offline supply-chain (egress off) resolving to the node stack, docs/skill/agent updated with no phantom `threatModelPath`, `.claude` sync byte-identical, and the offline smoke never touches an LLM. Typecheck, build, lint, and the full suite (323 files / **4276 tests** + 1 intentional skip) green. **This sprint closes spec-20260714 — all 10 sprints complete.**
