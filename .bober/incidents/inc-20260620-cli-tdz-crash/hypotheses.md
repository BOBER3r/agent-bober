# Incident inc-20260620-cli-tdz-crash — Hypotheses

**Symptom:** `agent-bober` CLI aborts at module-load with
`ReferenceError: Cannot access 'DEEP_MAX_TOTAL_CALLS' before initialization`
(dist/fleet/critic-deep.js:7). Global scope — every command dead. Introduced by `e4f7b6b`.

## H1 (CONFIRMED, confidence: HIGH) — Order-dependent circular-import TDZ

**Claim:** `critic-deep.ts` reads the imported bindings `DEEP_MAX_TOTAL_CALLS` and
`DEEP_EXPAND_MAX_RETRIES` at **module-evaluation time** (lines 16–18) to compute
`DEEP_CRITIQUE_MAX_TOTAL_CALLS`. Those bindings live in `decomposer-deep.ts`, which in turn
imports `runCritiqueLoop` from `critic-deep.ts` (line 5) — a cycle. When the module graph is
entered via `decomposer-deep` first (as the CLI does through `src/fleet/index.ts:27`),
`critic-deep`'s body runs while `decomposer-deep` is still mid-import, so `DEEP_MAX_TOTAL_CALLS`
is in its temporal dead zone → ReferenceError.

**Supporting evidence (≥2 independent boundaries — Iron Law satisfied):**
- Boundary A (static graph): the cycle + the module-init read exist in source.
- Boundary A' (entry order): CLI loads `decomposer-deep` before `critic-deep` via `fleet/index.ts:27`.
- Boundary B (runtime): native ESM stack places the crash in `ModuleJob.run` (evaluation), not at call time.
- Boundary C (differential): vitest passes 73/73 (safe order) while native CLI crashes (unsafe order).

**Active disproof attempt (REQUIRED):** TDZ-in-a-cycle is load-order dependent, so I tested both orders:
- `import(critic-deep)` FIRST → **OK**, value computes to `8` (4 + 1·((1+1)+(1+1))). This works because
  `decomposer-deep` only uses `runCritiqueLoop` *inside functions* (not at init), so it fully
  initializes `DEEP_MAX_TOTAL_CALLS=4` before control returns to `critic-deep`'s body.
- `import(decomposer-deep)` FIRST → **CRASH** (exact error).

The order-dependent result is *only* explainable by the cyclic module-init TDZ. This simultaneously
**disproves** the competing hypotheses: (a) stale dist — ruled out, fresh `npm run build`; (b) logic bug
in the arithmetic — ruled out, it yields `8` in the safe order; (c) constant simply undefined — ruled out,
same. H1 survived the disproof attempt with no contradicting evidence. **Promoted to HIGH.**

## H2 (REJECTED) — Stale `dist/` artifact
Rebuilt from clean `tsc`; crash persists identically. Source contains the same cycle. Rejected.

## H3 (REJECTED) — `grounding-critic.ts` participates in the cycle
The grep hit was a **comment** (grounding-critic.ts:203 cites critic-deep behavior); no real import.
The cycle is purely `decomposer-deep ⇄ critic-deep`. Rejected.

## Remediation (nextAction) — blastRadius: safe, requiresApproval: false (code fix, git-reversible)
Break the **module-init** dependency (not necessarily the whole cycle): move the leaf constants
`DEEP_MAX_TOTAL_CALLS`, `DEEP_EXPAND_MAX_RETRIES` (and `DEEP_PLAN_MAX_RETRIES` for cohesion) into a new
no-import module `src/fleet/decomposer-deep-constants.ts`; have both `decomposer-deep.ts` and
`critic-deep.ts` import them from there. The function-level cross-imports (`runExpandStage`,
`runCritiqueLoop`) remain but never execute at init, so no load order can TDZ.
(Alternative: make `decomposeGoalDeep` dynamic-`import()` `runCritiqueLoop`, fully cutting the cycle.)

This is code-level + deterministic → hand off to **bober.debug / bober.sprint** for the fix, with a
regression test asserting `await import('./decomposer-deep.js')` alone succeeds.

## Pre-defined resolution criteria (set BEFORE fix)
- **Metric:** TDZ ReferenceErrors on CLI cold start + module load order.
- **Threshold:** 0 errors; `--help`/`--version` exit 0; BOTH `import(critic-deep)`-first and
  `import(decomposer-deep)`-first succeed; full `vitest run` stays green (no test regressions).
- **Window:** all 3 commands + both load orders in a single post-build run.
- **Baseline:** pre-`e4f7b6b` behavior (CLI booted normally).
- **Verification source:** `npm run build` then `node dist/cli/index.js <cmd>` + `node -e import()` both orders + `npx vitest run`.
