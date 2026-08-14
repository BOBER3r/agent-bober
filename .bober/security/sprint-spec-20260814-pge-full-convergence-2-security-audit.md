# Security Audit — sprint-spec-20260814-pge-full-convergence-2

Scope: `git diff b42af01..275f074` (commits `7237c56`, `275f074`) — the sprint that makes the `git`-effect `commit` node execute for the first time.
Verdict after adversarial verification: **1 important (confirmed, being fixed), 2 minor (downgraded), 1 disproved.**

All four auditor findings were handed to a fresh-context verifier instructed to disprove them.

## The authorization boundary holds

The fail-closed property is **not** weakened. Verified independently:
- `createReplayEffectRegistry.invoke` (`replay.ts:385-424`) never calls `inner.invoke` — a replayed `git.commit` is answered from the recording. This is the path every CI and gate run takes.
- Capture's committer is the `"0000000"` stub (`whole-graph.ts:410-413`).
- `interrupt.ts:523`'s grant rule and `:536-544`'s gated-effect refusal are byte-intact; `noop` still grants nothing.
- Checkpoint ids are a closed 9-value union (`checkpoints/types.ts:16-37`), which is what makes `disk.ts:75-78`'s marker filenames traversal-proof.
- The new fixture carries `<projectRoot>` everywhere a root appears; no secrets, absolute paths or environment values.

## IMPORTANT (confirmed) — the finalize audit names the wrong mechanism

`finalizePipelineRun` labels its audit record from `config.pipeline?.checkpointMechanism ?? "noop"` (`finalize.ts:220-221`), ignoring `checkpointOverrides`, while the mechanism actually invoked at `:256` resolves through `getCheckpointMechanismFor`, which honours them (`registry.ts:76-77`). One run therefore emits two labels for the same checkpoint id — `interrupt.ts:461-463` and `:530-532` use the override-aware `resolveCheckpointMechanismName`. The committed fixture proves it: `audits[0]`/`[1]` read `"disk"`, `audits[2]` reads `"noop"`, all `end-of-pipeline`, same run.

**The verifier found it worse than reported.** `approverId` derives from the same wrong label (`audit.ts:166-199`), so the reverse combination — `checkpointMechanism: "disk"` + `checkpointOverrides: {"end-of-pipeline": "noop"}`, accepted by `schema.ts:365-367` — writes `outcome: "approved"` (noop always approves, `noop.ts:15`) with an approverId resolved from `git config user.name`. A named human is credited for an approval autopilot rubber-stamped, in a 0600 append-only attribution log.

Not critical: the audit trail is evidence, not admission control — nothing downstream cites it as a grant, and the fail-closed gate reads the interrupt controller's own grant map.

Pre-existing in `finalize.ts`, but **this sprint is the first to exercise and pin it**, so leaving it would enshrine a wrong expectation and make a later correction read as a golden regression. Fix dispatched: derive the label from `resolveCheckpointMechanismName("end-of-pipeline", config)`, re-capture, and pin that the two paths cannot diverge silently again.

## MINOR (downgraded from important) — the allowlist is enforced on replay only

`assertExecutable` (`executor.ts:439`) refuses any non-`{approved:true}` `input.config`, but capture gates on `configInput !== undefined` (`capture.ts:145,147`) and `resolveGoldenConfig` (`executor.ts:189`) returns the approved config for any non-undefined value.

**Downgraded because not attacker-reachable:** the sole caller passes the code constant `GOLDEN_APPROVED_CONFIG_INPUT` (`capture.test.ts:15,235`), a caller who could pass anything else already supplies `bindings` wholesale, the recorded run is confined to a mkdtemp root with a stub committer, and the mismatch self-detects in the same call at `capture.ts:236`. A consistency wart, not CWE-20 with an untrusted source. Cheap hardening dispatched alongside the fix above: share one predicate.

## MINOR (downgraded from important) — `gitCommitEffect`'s committer default

`DEFAULT_COMMITTER = commitAll` (`effects.ts:959`), `TerminalBindings.committer` is optional (`:1018`), and the composition passes it through (`registry/index.ts:373`).

**Downgraded because "fails open" mischaracterises it:** authorization is the interrupt gate, not the binding — `interrupt.ts:527-557` refuses to dispatch any `git`-tagged node without a recorded in-scope approval, and `registry/effects.ts:147-150` independently throws `EffectNotDeclaredError`. Blast radius is bounded even if the default fired: `commit.ts:224` passes `cwd: ctx.projectRoot`, always a mkdtemp root with no `.git` ancestor, so `git add -A` errors rather than commits. And production deliberately omits the binding (`pge-engine.ts:275-292`) because committing IS the shipped behaviour. Residual, recorded: a future composition that both forgot the binding and ran with `runRootParent` inside the checkout would reach the real primitive.

## DISPROVED — `withGoldenApproval` restore ordering

Both claimed triggers are unreachable. `startGoldenApprover`'s loop (`executor.ts:327-356`) has no unguarded throw site — `readdir` is `.catch(() => [])`, the write/rename pair is in try/catch, the timeout promise cannot reject — so `stop()` cannot reject and the restore at `:397` always runs. Between the swap and the `try`, the only statement is an async IIFE whose throw becomes a rejected promise, never a synchronous throw. Even hypothetically, the leak points at a deleted temp dir, so later approvals time out — fail-closed.

## Approved areas

- `withGoldenApproval` scopes the disk mechanism to a fresh mkdtemp run root and restores the exact original reference; all call sites drive cases sequentially, and vitest's per-file isolation keeps the module registry unshared.
- `executor.ts:176-179,439-444` — exact-shape allowlist on the executed path, deliberately distinct from the `{autopilot:true}` shape that stays refused.
- `executor.test.ts:294-324` — the safety property is asserted, not assumed: no `.bober/approvals/` in the checkout, `git rev-parse HEAD` unchanged, disk singleton restored by reference identity.
- `replay-full-run-evaluation-passes.json:950-957` — the no-approval case still pins the FAIL_CLOSED refusal, so fail-closed remains enforced by a committed regression case, not only prose.
- `src/index.ts` — the golden executor, `goldenApprovedConfig` and `withGoldenApproval` are not on the package's public API surface.
