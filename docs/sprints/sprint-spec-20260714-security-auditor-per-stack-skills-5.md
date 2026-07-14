# Stack registry + knowledge index + selector + context resolver, wired into the finder (fixes G3)

**Contract:** sprint-spec-20260714-security-auditor-per-stack-skills-5  ·  **Spec:** spec-20260714-security-auditor-per-stack-skills  ·  **Completed:** 2026-07-14

## What this sprint added

This is the **milestone sprint** that turns the eight dormant per-stack signature libraries (authored in sprints 2–4) into **live, retrieval-grounded audit context**. It builds a four-stage retrieval pipeline — **registry → index → selector → resolver** — under `src/orchestrator/security-knowledge/` and wires it into `runSecurityAudit`, so the finder now receives **real per-stack signatures** rendered into its prompt rather than a frontmatter/head-excerpt of a skill file.

This **closes G3**, the defect where the old head-excerpt resolver injected frontmatter filler for `unknown`/`anchor`/`react` stacks. The new resolver's `promptFragment` is **never empty**: every stack — including `generic` — resolves to concrete signature blocks, and an unrecognised/absent/null stack degrades to the shared `generic` floor rather than to boilerplate. The old head-excerpt machinery (`resolveStackSecurityContext`, `extractSecurityExcerpt`, `readSkillSecurityExcerpt`, `detectStack`, `STACK_SKILL_MAP`) was **removed** from `stack-knowledge.ts` (only `ALL_VULN_CLASSES` remains there), and its test file `stack-knowledge.test.ts` was deleted.

The read-only curator toolset, the fail-closed parse, and `deriveVerdict` are all **unchanged**; a config omitting `security` is byte-identical.

## Public surface

All new modules live under `src/orchestrator/security-knowledge/`.

- `SecurityStackRegistry.resolve(stack)` (`registry.ts:120`) — maps a declared/detected `Stack` (or plain string, or `undefined`) to a `StackResolution {stackId, stackLabel, skillName}`. Every one of the 8 `SecurityStackId`s (including `generic`) resolves to a real `bober.security-<stack>` skill name; unknown/absent/null → `{stackId: "generic", ...}`. **Never null, never throws.** Precedence (blockchain/language keywords before frontend/backend) is ported verbatim from the old `detectStack`.
- `STACK_SKILL_MAP_ENTRIES` (`registry.ts:31`) — the 8 `{stackId, skillName}` pairs the index iterates to load each skill file.
- `SecurityKnowledgeIndex` (`index.ts:35`) — a **per-process memoised** catalog (ADR-7). `load()` parses all 8 `skills/bober.security-*/SKILL.md` files once via `SecuritySignatureParser`; `forStack(stackId)` returns that stack's `SecuritySignature[]` (missing skill ⇒ `[]`); `all()` returns the union. A `skillsRoot` constructor arg is the test-injection seam. Missing/unreadable file ⇒ `[]`, **never throws**.
- `selectSignatures(input)` (`selector.ts:43`) — **pure + total** top-K ranker: `score = stack membership (+3) + keyword overlap (+2 each) + path hint (+1)`, caps ranked signatures at `topK`, then **ALWAYS** concatenates the `genericFloor` (deduped by `signatureId`) so the floor is present even when it did not rank on its own merit.
- `resolveStackSecurityContext(input)` (`resolver.ts:91`) — the new retrieval-based resolver. Returns `StackSecurityContext {stackId, stackLabel, skillName, taxonomy, signatures, promptFragment}`. `promptFragment` renders each selected signature (`id — title (CWE)`, invariant, fenced unsafe/safe examples) plus an optional `threatModelText`, and is **never empty** — it falls back to `resolveLensFocus("security")` only if the selected set is somehow empty (which the generic floor normally prevents). Default `topK` is 8.
- `StackSecurityContext` (`resolver.ts:18`) — replaces the old head-excerpt context type; `stackId` and `signatures` are new, and `promptFragment` now carries rendered signatures.

## How it fits

`runSecurityAudit` (`security-auditor-agent.ts:61`) now builds its stack context through the pipeline:

1. A module-level `getSecurityKnowledgeIndex()` (`security-auditor-agent.ts:24`) lazily constructs **one `SecurityKnowledgeIndex` per process** (ADR-7 — no runtime cache invalidation) and `await`s `load()` on it.
2. `resolveStackSecurityContext` is called with `config.project.stack` and `contract.estimatedFiles` as `changedPaths` (with `diffKeywords: []`) — this is the **sprint-6 seam**: the git diff provider lands next sprint, so for now the finder's retrieved signatures are ranked against the sprint's estimated-files scope rather than a real diff.
3. `ctx.promptFragment` is folded into `buildUserMessage`'s `# Stack Security Context` section, so the retrieved signatures reach the finder's user message verbatim.

The end-to-end audit test (stubbed agentic loop) captures the user message and asserts a retrieved signature id/title actually appears in it — the proof that real signatures reach the finder.

Internally the resolver uses the registry to pick the stack, the index to fetch that stack's signatures **and** the generic floor (`index.forStack("generic")`, or the same set when the stack *is* generic), and the selector to rank + guarantee the floor.

## Notes for maintainers

- **`index.ts` is NOT a barrel.** Despite the filename, `src/orchestrator/security-knowledge/index.ts` is the `SecurityKnowledgeIndex` class module, not a re-export barrel — import it explicitly as `./security-knowledge/index.js`.
- **The index iterates the registry, not `readdir`.** `load()` walks `STACK_SKILL_MAP_ENTRIES` (the 8 known stacks) rather than listing the skills directory, deliberately **excluding** `skills/bober.security-audit/` (the orchestration *workflow* skill, not a signature stack) and giving the parser a known `stackId` per file.
- **ADR-7: one memoised index per process, no invalidation.** Editing a `SKILL.md` file mid-process will not be picked up until the process restarts. The `getSecurityKnowledgeIndex()` singleton has a comment noting where to swap in an injectable dependency if per-request skill reloading is ever needed.
- **The generic floor is the G3 guarantee.** `selectSignatures` always includes the generic-floor signatures, and the resolver only falls through to the `resolveLensFocus("security")` text if the selected set is empty — which requires a wholly missing skills directory. In normal operation every audit gets concrete signature blocks.
- **`ALL_VULN_CLASSES` stayed put.** It is still exported from `stack-knowledge.ts` (several unrelated modules import it from that path); only the stack→skill resolver machinery moved out. The `stack-knowledge.test.ts` file was genuinely deleted (its subject no longer lives there).
- **Invariants preserved.** No `Bash`/`Write`/`Edit` was added to the auditor toolset (still the read-only `curator` role — `read_file`/`glob`/`grep`); the fail-closed parse (`parsed:false` ⇒ `verdict:'blocked'`) and `deriveVerdict` are untouched; a `security`-omitting config parses byte-identically.

## Follow-ups (non-blocking, out of scope this sprint)

- **Real git diff provider (sprint 6).** `changedPaths` come from `contract.estimatedFiles` and `diffKeywords` is `[]` for now; sprint 6 supplies a real diff, at which point the selector's keyword/path scoring becomes materially more discriminating.
- **Supply-chain scanners + the verifier (sprints 7–8) remain pending.**
- **`topK` is a hardcoded default of 8** in the resolver, tunable via config in a later step (per the contract's assumptions).

## Scope

One commit — `a081f35` (`bober(sprint-5): per-stack registry + knowledge index + selector + retrieval resolver wired into finder (fixes G3)`). Adds `registry.ts`, `index.ts`, `selector.ts`, `resolver.ts` (+ their `*.test.ts`) under `src/orchestrator/security-knowledge/`; rewires `security-auditor-agent.ts` (+ test); strips the head-excerpt resolver from `stack-knowledge.ts` and deletes `stack-knowledge.test.ts` (917 insertions, 363 deletions across 12 files). All 6 required criteria (sc-5-1..5-6) passed on iteration 1; typecheck, build, lint, and the full suite (318 files / **4134 tests**) green. G3 closed.
