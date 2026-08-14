# Security Audit — sprint-spec-20260812-terminal-vocabulary-4

Scope: `git diff 2dd76e7..HEAD` (commits 20220a7, a1b7178, 949661d, 5da9940, a0a327b, 749a83a)
Verdict: **PASS for this sprint.** The one critical is real but PRE-EXISTING and outside this diff; two mediums are defence-in-depth gaps with no reachable path today.

## The version-stripping fix from sprint 3's audit is COMPLETE

Independently confirmed on both branches of `materializeContracts`: the embedded branch deletes a producer-supplied `version` before `saveContract` (`contract-materialization.ts:66-77`), and the feature-derived branch needs no equivalent because `createContract` (`sprint-contract.ts:255-286`) constructs no `version` key at all. `mcp/tools/plan.ts:98-113` also routes through `createContract`. No other code path feeds producer data into a persisted contract or into the `sprintContracts` channel.

## The `attempts` widening opens no reachable producer path

Every post-parse channel value domain flowing through `rankIsGreater` — SprintContract, GraphMessage, SprintVerdict, ScratchRef, PlanSpec — lacks a numeric `attempts` field, and effect responses are zod-parsed before reaching a channel (`nodes/effects.ts:334-363, 853-860`).

## CRITICAL (pre-existing, not introduced here) — NUL bytes make reducers.ts invisible to scanners

`src/pge/registry/reducers.ts` contains two literal NUL (0x00) bytes in a composite-key template literal (currently ~line 460), used as a delimiter between `nodeId`, `attempt` and `callIndex`.

**Orchestrator verification (byte-level, not inferred):**
- `perl -ne 'print if /\x00/'` reports 2 NUL bytes on one line.
- `file` reports `data`, not text. `grep -c` for `joinByCanonicalOrder|higherRanked|rankIsGreater` returns nothing — grep bails — even though all three are DEFINED in that file.
- The bytes survive into `dist/pge/registry/reducers.js` (2 NULs there too).

**Consequence** (the auditor's reasoning, upheld): semgrep and gitleaks skip binary files, and this repo's security gate drives both. So the one function deciding which of two conflicting values survives every channel merge is invisible to the tooling meant to audit it.

**Provenance — determined, which the auditor could not do from the working tree alone: PRE-EXISTING.** Present at `main` (4aef5ea) before this spec began, at line 413 then. Not a regression from any sprint in this spec, so it does not block sprint 4.

**Disposition:** spawned as a separate task (`task_9e3c1791`) rather than fixed mid-pipeline. The fix is to write the delimiter as a six-character unicode escape sequence instead of a literal byte, which is byte-identical at runtime (the golden gate passing unchanged would prove it), plus a repo-invariant test forbidding NUL bytes under `src/`. An in-pipeline fix attempt was blocked by the permission classifier, which is the correct outcome for scope expansion.

*(The auditor also recorded a non-reproducing observation that one early read of line 317 rendered differently from four subsequent reads. That is an artifact of reading a binary file; the auditor drew no conclusion from it and neither does this record.)*

## MEDIUM — rank is decided on UNVALIDATED update values, one step before the state schema

`commit.ts:423` calls `compiled.reducer.merge(...)` on raw `update.value` objects; `OverallStateSchema.parse` runs only afterwards (`:441`). Zod strips unknown keys, so an update carrying an extra numeric `attempts` or `version` would dominate the join and then have that key silently removed — the committed state would show the preferred value with no trace of why it won.

This qualifies the safety comment now written into the code (`reducers.ts:382`): "no other value domain in the topology carries a numeric `attempts` field" is true of POST-parse shapes but says nothing about the PRE-parse values the reducer actually ranks. **No reachable actor path today** — every writer's value is either constructed in code (`sprint_exit`, `plan_materialize`) or returns through an effect `responseSchema` parse. The mitigating property (validate-then-rank) is currently accidental rather than enforced.

## MEDIUM — `version` normalization is per-call-site, not structural

`SprintContractSchema.version` is `.int().min(0).optional()` with no upper bound, and `saveContract` persists whatever the caller supplies, while the legitimate writer only ever sets a small evaluation count. Residual exposure: (a) a planner subagent writing `.bober/contracts/*.json` directly bypasses `materializeContracts` entirely (documented practice, `contract-materialization.ts:11-13`); (b) `workload-build.ts:212` reads those files straight into a `sprintContracts` channel value with `version` intact — test-harness-only today. Bounding `version` at the schema, or deriving it exclusively at `sprint_exit`, would make the invariant structural rather than per-call-site.

## MINOR — the module header's `replaceIfNewer` justification is inaccurate for one channel

The header argues scalar channels stay single-writer so `replaceIfNewer` "never meets a real conflict", but `specDraft` is written by `plan_draft` on every clarification round, so successive drafts are a real same-channel conflict resolved by `versionRank`. That term reads `PlanSpec.version`, which is producer-supplied (`spec.ts:127`, `.min(1).default(1)`, no upper bound). PRE-EXISTING — `replaceIfNewer` already ranked on `version` before this sprint; recorded for accuracy of the reasoning the module now leans on.

## Approved areas

- `sprint-review.ts:200-216` — `version` derived from a replay-stable, branch-local count, keeping the settled copy's rank code-controlled and bounded.
- `sprint-state.ts:19-23` — `contractPath` sanitizes the id to `[a-zA-Z0-9_-]`, containing traversal on an identifier that producer-authored specs influence.
- `commit.ts:439-441` — the merged channel set is re-parsed through the state schema rather than cast, confining the pre-parse ranking gap to unknown-key influence with no persistence.
- All 43 golden fixtures including the five re-captured — no secrets, API keys, bearer tokens, absolute paths or environment values; plain text throughout.
