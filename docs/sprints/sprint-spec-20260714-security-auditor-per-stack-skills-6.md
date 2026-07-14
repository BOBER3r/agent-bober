# Orchestrator-owned real-diff provider wired into the audit (fixes G4), auditor stays read-only

**Contract:** sprint-spec-20260714-security-auditor-per-stack-skills-6  ·  **Spec:** spec-20260714-security-auditor-per-stack-skills  ·  **Completed:** 2026-07-14

## What this sprint added

This sprint gives the auditor the **actual changed code** for a sprint instead of the planner's `estimatedFiles` guess — **without granting the auditor a git or Bash tool**. It adds `SecurityDiffProvider`, an orchestrator-owned, never-throwing component that shells `git` in orchestrator Node to compute a real, bounded `AuditDiff` (changed files + unified hunks, plus an optional tokensave call-graph neighborhood), and wires it into `runSecurityAudit` behind a new opt-in `config.security.diff` block.

This **closes G4** — the sprint-5 seam where the selector ranked signatures against `contract.estimatedFiles` and `diffKeywords: []` — while preserving the **read-only-curator invariant (ADR-5)**: git runs only in orchestrator Node, so the auditor toolset stays `Read`/`Grep`/`Glob` with no `Bash`/`Write`/`Edit` added. The feature is **default-off**: `diff.mode` defaults to `"estimated-files"` (today's exact behavior), and a config omitting `security.diff` parses byte-identically. In `git-diff` mode the real changed hunks reach both the selector (as `changedPaths` + extracted `diffKeywords`) and the finder prompt (rendered inline), and an injected fake diff provider proves a `.raw(` hunk drives signature selection.

## Public surface

New module `src/orchestrator/security-knowledge/diff-provider.ts`.

- `securityDiffProvider.compute(input)` (`diff-provider.ts:391`) — the default `SecurityDiffProvider`. Given `{projectRoot, baseRef?, expandWithGraph, signal, config?, runner?}`, returns an `AuditDiff`. **Never throws**: any git failure (ENOENT / not-a-repo / abort / malformed output) or any thrown error degrades to `EMPTY_DIFF`. It resolves a base ref, runs `git diff --name-status <baseRef>` and `git diff -U3 <baseRef>`, and parses both into `ChangedFile[]`.
- `AuditDiff` (`diff-provider.ts:38`) — `{changedFiles: ChangedFile[], neighborhoodFiles: string[], truncated: boolean}`. **The shared input type sprints 7 (supply-chain) and 8 (verifier) will also consume** — kept clean and exported.
- `ChangedFile` (`diff-provider.ts:32`) — `{path, status: "added"|"modified"|"deleted"|"renamed", hunks: DiffHunk[]}`.
- `DiffHunk` (`diff-provider.ts:26`) — `{startLine, lineCount, content}` (raw unified-diff hunk text).
- `EMPTY_DIFF` (`diff-provider.ts:44`) — the frozen `{changedFiles:[], neighborhoodFiles:[], truncated:false}` degrade target; callers treat it as "fall back to `estimatedFiles`".
- `SecurityDiffProvider` (`diff-provider.ts:381`) / `SecurityDiffComputeInput` (`diff-provider.ts:370`) — the provider interface and its input shape (the `runner` and `config` fields are the test-injection seams).
- `GitRunner` / `GitRunResult` (`diff-provider.ts:54`, `:48`) — the injectable never-throw git runner type (mirrors `security-scanners.ts`'s `ScannerRunner`); the default wraps `execa` with `reject:false` + `cancelSignal`.
- `parseUnifiedDiff(nameStatus, unified)` (`diff-provider.ts:245`) — **pure + total** parse of the two git outputs into `{files, truncated}`, bounded by `MAX_CHANGED_FILES` (60 files) and `MAX_HUNK_BYTES` (256 KB total hunk content); exceeding either sets `truncated: true`. Skips malformed lines rather than throwing.
- `extractDiffKeywords(files)` (`diff-provider.ts:308`) — **pure + total** tokenizer over changed-hunk text (added/removed lines' identifiers plus a `NOTABLE_SUBSTRINGS` list: `.raw(`, `FOR UPDATE`, `postinstall`, `dangerouslySetInnerHTML`, `eval(`, `child_process`, `SELECT `, `__proto__`, …). Feeds the selector's keyword-overlap ranking; it need not be perfect.
- `config.security.diff` (`SecurityDiffConfigSchema`, `src/config/schema.ts`) — new **optional** object `{mode: "estimated-files" | "git-diff" (default "estimated-files"), baseRef?: string, expandWithGraph: boolean (default false)}`. Optional with **no outer default** — a config omitting `diff` stays byte-identical, same guarantee as `security` itself.
- `SecurityAuditDeps` (`security-auditor-agent.ts`) — new injectable-deps type; currently `{diffProvider?: SecurityDiffProvider}`. Added as `runSecurityAudit`'s **last positional param** (`deps = {}`), so every existing positional caller stays byte-compatible. Lets tests inject a fake provider and never shell real git.

## How it fits

`runSecurityAudit` (`security-auditor-agent.ts`) computes the diff **once**, before resolving stack context:

1. If `config.security?.diff?.mode === "git-diff"`, it calls `deps.diffProvider ?? securityDiffProvider`, threading `diff.baseRef`, `diff.expandWithGraph`, the full `config`, and a fresh `AbortSignal` (time-boxed by `security.timeoutMs`, default 300 s). Otherwise `changedPaths` stays `contract.estimatedFiles` and `diffKeywords` stays `[]` — **byte-identical to sprint 5**.
2. When the computed diff has ≥1 changed file, `changedPaths` becomes the real changed paths and `diffKeywords = extractDiffKeywords(...)`; these feed the sprint-5 `resolveStackSecurityContext` selector so keyword/path scoring becomes materially more discriminating.
3. The `AuditDiff` is passed read-only into `buildUserMessage`, which renders a `# Changed files (real diff)` section (per-file `## <path> (<status>)` + hunk text, an optional call-graph-neighborhood list, and a truncation note). When a real diff is present the finder's task instructions switch from "Glob the estimatedFiles patterns" to "ground findings in the real diff"; the "you have Read/Grep/Glob only (no Bash, no git)" line is retained.

**Base-ref resolution** (`resolveBaseRef`, `diff-provider.ts:121`): explicit `baseRef` wins; else the merge-base with the detected default branch (`origin/HEAD` → `origin/main`/`origin/master`/`main`/`master`); else `HEAD~1`. Every probe goes through the never-throw runner.

**Graph neighborhood** (sc-6-2, `collectGraphNeighborhood`, `diff-provider.ts:343`): only when `expandWithGraph` is true **and** `getGraphState(config).engineHealth === "ready"`. It calls `getGraphDeps().client.impact(path)` per changed path; a per-file miss (`{ok:false}` or a thrown call) is isolated and never drops the other files or the git-derived `changedFiles`. Not ready / no deps ⇒ `neighborhoodFiles: []`.

An injected fake diff provider with a `.raw(` hunk proves — via the stubbed finder loop — that the hunk reaches the finder prompt and that a matching signature is selected (the diff-driven-selection proof, sc-6-4).

## Notes for maintainers

- **ADR-5 — the orchestrator owns the diff.** The alternative (giving the auditor a git/Bash tool to self-diff) was rejected because it breaks the read-only-curator invariant for a security-critical role. git runs **only** in `diff-provider.ts`, in orchestrator Node; the auditor toolset is provably unchanged. See [`arch-20260714-security-auditor-per-stack-skills-adr-5.md`](../../.bober/architecture/arch-20260714-security-auditor-per-stack-skills-adr-5.md).
- **Never-throw is load-bearing, not defensive politeness.** The provider degrades to `EMPTY_DIFF` on *any* failure, and an empty diff in `git-diff` mode falls back to `estimatedFiles` behavior — so a broken git environment (no repo, no `git` binary, detached HEAD, abort) never crashes the audit and never blocks the gate. This mirrors `security-scanners.ts`'s injectable never-throw runner shape (Pattern A).
- **Default is fail-safe.** `git-diff` is deliberately **not** the default; `estimated-files` (today's behavior) is. Opting in is a per-project config choice.
- **Caps prevent a diff from blowing the prompt.** `MAX_CHANGED_FILES` (60) and `MAX_HUNK_BYTES` (256 KB total) bound a huge rewrite / vendored-file commit; exceeding either sets `truncated: true` (surfaced to the finder as a "diff truncated" note) rather than degrading silently.
- **Keyword extraction feeds ranking, not correctness.** `extractDiffKeywords` is a cheap substring/identifier tokenizer, not a grammar — it hints the selector's keyword-overlap score and never needs to be exhaustive.
- **`index.ts` is still not a barrel** — `SecurityDiffProvider` is imported from `./security-knowledge/diff-provider.js` directly (consistent with sprint 5's note about `security-knowledge/index.js`).
- **Positional-caller compatibility.** `SecurityAuditDeps` is appended last with a `{}` default; do not reorder `runSecurityAudit`'s params.

## Follow-ups (non-blocking, out of scope this sprint)

- **Supply-chain scanners + offline inspector (sprint 7)** and the **fresh-context finding verifier (sprint 8)** remain the next items. Both consume the same `AuditDiff` this sprint introduced.
- **`baseRef` and `expandWithGraph` are opt-in and unexercised in the dogfood config** (which stays `estimated-files`); live git-diff-mode fidelity against a real branch is a manual follow-up.

## Scope

One commit — `73cf22d` (`bober(sprint-6): orchestrator-owned real-diff provider wired into audit (fixes G4)`). Adds `diff-provider.ts` (+ `diff-provider.test.ts`) under `src/orchestrator/security-knowledge/`; adds `SecurityDiffConfigSchema` + `security.diff` to `src/config/schema.ts` (+ test); threads the diff through `security-auditor-agent.ts` via `SecurityAuditDeps` + a `renderChangedFilesSection` prompt section (+ test). 1094 insertions / 10 deletions across 6 files. All 6 required criteria (sc-6-1..6-6) passed on iteration 1; typecheck, build, lint, and the full suite (319 files / **4161 tests**) green. G4 closed.
