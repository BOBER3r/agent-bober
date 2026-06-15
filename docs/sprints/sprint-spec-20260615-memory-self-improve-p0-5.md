# Auto-producer: deterministic project-fact detector + fact retrieval into context

**Contract:** sprint-spec-20260615-memory-self-improve-p0-5  ·  **Spec:** spec-20260615-memory-self-improve-p0  ·  **Completed:** 2026-06-15

## What this sprint added

Closes the loop on the semantic-facts store: facts now **populate themselves** (no manual
`bober facts add`) and **feed planning**. A pure, deterministic detector reads the project's
manifests/config and emits project facts (`testCommand`, `buildCommand`, `packageManager`,
`framework`), which a thin IO caller writes through Sprint 2's idempotent `writeFact` at
`runPipeline` and chat-session startup — both guarded so a facts failure can **never** abort a
run. A new retrieval path (`retrieveRelevantFacts` + `serializeFactsForContext`) injects
scope-isolated, char-budgeted active facts into the planner's context, mirroring the lessons
path. With this sprint **the entire `spec-20260615-memory-self-improve-p0` plan is complete
(5 of 5)**. No LLM runs on the produce path.

## Public surface

- `detectProjectFacts(inputs, scope = "")` (`src/orchestrator/memory/fact-detector.ts:58`) — **PURE**: maps already-parsed `{ packageJson, boberConfig?, lockfiles? }` into `FactDraft[]`. No fs, no `Date`, no `createClient`. Rules: `scripts.test → project/testCommand`, `scripts.build → project/buildCommand`, first lockfile present (`npm > yarn > pnpm`) `→ project/packageManager`, first dep found (`next > react > vue`) `→ project/framework`.
- `ProjectInputs` / `FactDraft` types (`src/orchestrator/memory/fact-detector.ts:25,41`) — `FactDraft` is `Omit<FactInput, "tValid" | "tCreated">` (the caller stamps the clock).
- `seedProjectFacts(projectRoot, namespace?)` (`src/orchestrator/memory/fact-detector.ts:144`) — thin IO caller: the **only** fn here that touches fs/clock. Reads `package.json` + `bober.config.json` + lockfile presence (missing files are normal → partial drafts), stamps one wall-clock `now`, and writes each draft via `writeFact` (idempotent via reconcile). Never throws for missing files.
- `retrieveRelevantFacts(projectRoot, scope, keywords, { topK?, namespace? })` (`src/orchestrator/memory/fact-retrieve.ts:83`) — one store open/read/close, then pure ranking. Returns scope-isolated **active** facts (scope isolation enforced by `FactStore.getActiveFacts(scope)` SQL `WHERE scope=? AND t_invalidated IS NULL`), ranked by deterministic token-overlap (score DESC, then `id` ASC tiebreak). Empty/non-matching keywords → empty result.
- `serializeFactsForContext(records, { charBudget? })` (`src/orchestrator/memory/fact-retrieve.ts:128`) — header + one `- subject/predicate: value` line per fact, **hard-sliced to `charBudget`** (output length guaranteed ≤ budget; `0 →` `""`). Defaults: `DEFAULT_TOP_K = 5`, `DEFAULT_CHAR_BUDGET = 1200`.

## How to use / how it fits

There is **no new CLI surface** — auto-production and retrieval are wired into existing entry
points and run for free:

- **Production.** `seedProjectFacts(projectRoot, team.memoryNamespace || undefined)` is called near the start of `runPipeline` (`src/orchestrator/pipeline.ts:1030`, after `loadTeam`, before `engine.run`) inside a `try/catch` that `logger.warn`s and continues; and in `ChatSession.start()` (`src/chat/chat-session.ts:504`, after the banner, before the `for await` loop) inside a silent `try/catch`. After a `bober run` / `bober chat` in a project with a `package.json`, `.bober/memory/facts.db` holds active `project/testCommand` and `project/buildCommand` facts.
- **Retrieval.** `runPlanner` (`src/orchestrator/planner-agent.ts`) derives keywords from the user prompt, calls `retrieveRelevantFacts(projectRoot, "", keywords, { topK: 5 })`, and appends `serializeFactsForContext(facts, { charBudget: 1200 })` to the planner `userMessage` (alongside the existing Project Context / research / architecture sections), all guarded — a retrieval failure leaves planning untouched.

The serialized block the planner sees looks like:

```
## Project facts (durable semantic memory)

- project/testCommand: vitest run
- project/buildCommand: tsc -p tsconfig.json
- project/packageManager: npm
- project/framework: react
```

## Notes for maintainers

- **Pure vs IO boundary is load-bearing.** `detectProjectFacts` must stay pure (no fs/clock/LLM) — it mirrors `distill.ts`. All fs reads and the single `new Date().toISOString()` live in `seedProjectFacts`. Keep new detection rules inside the pure fn and any new IO in the seed caller.
- **No LLM on the produce path.** The only LLM in the facts layer remains Sprint 2's reconcile ambiguity branch (`createLLMFactJudge`), which is **not** wired into `seedProjectFacts` — the seed path runs the deterministic `add`/`update`/`noop` branches only.
- **Guards are intentional.** Both wiring sites and the planner injection swallow/warn-and-continue. This is deliberate: fact production/retrieval is best-effort and must never block a run or a plan. The `pipeline.ts` / `chat-session.ts` / `planner-agent.ts` changes are additive only (no phase reorder).
- **Scope `""` everywhere.** Detector, retrieval, and planner injection all use `scope = ""` (default/programming team). `scope` is the per-DB isolation axis; the team **namespace** is the separate axis that selects the `facts.db` file location.
- **Empty keywords yield no facts.** `retrieveRelevantFacts` returns `[]` when no keyword overlaps a fact (mirrors `retrieve.ts`). Project facts are few with known predicates, so callers should pass relevant prompt-derived keywords to surface them.
</content>
</invoke>
