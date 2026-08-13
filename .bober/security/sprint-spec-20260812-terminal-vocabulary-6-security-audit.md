# Security Audit — sprint-spec-20260812-terminal-vocabulary-6

Scope: `git diff 14efc5f..HEAD` (commits 53986cf, ba937e6, b022cbf; the follow-up 5afaa9c is docs-only)
Verdict: **PASS** — 0 critical, 1 important (pre-existing, not introduced here), 0 minor.

The diff is documentation and test code only. No untrusted input, no trust boundary, no shell, network, or filesystem write reaches anything outside an `mkdtemp` directory.

## The new doc-gutting controls are strictly in-memory — verified

- `writeFile` appears only at `docs.test.ts:180` and `:187`, both targeting `join(root, ...)` where `root = await mkdtemp(join(tmpdir(), "bober-pge-docs-"))` (`:36`); `rm` is confined to `rm(root, {recursive, force})` (`:40`). No write, delete or rename ever targets a repo path.
- The four gutting controls (`:1039-1044, 1064-1078, 1084-1090, 1096-1126`) each derive a new immutable string via `shippedDoc.split(x).join(y)` from the single read at `:249`, so `docs/pge-graph.md` on disk cannot be mutated by any test.
- The real repo paths are read-only by construction: `DOC_PATH` reaches only `readFile` (`:249`) and `checkDocDrift` (`:467, :504`); `ARTIFACT_PATH` only `readTopologyArtifact` (`:240`). `checkDocDrift` imports only `readFile` and calls it once (`docs.ts:123`). `readTopologyArtifact` (`dump.ts:210-224`) does `readIfPresent` + `JSON.parse` only — the `mkdir`/`writeFile` at `:193-194` belong to a separate `dump` function the tests never invoke.

## IMPORTANT (pre-existing, not introduced here) — a SECOND file is opaque to content scanners

`src/pge/topology/docs.test.ts` contains two raw NUL bytes on **line 308**, used as the separator inside both `join()` calls of the `sortRows` comparator. Ripgrep-based scanners classify the file as binary and suppress all matching lines, so its contents are invisible to the deterministic-scanner layer of the security gate — a blind spot in the control itself rather than an exploitable flaw.

**Confirmed pre-existing, and this sprint added none.** `rg` reports 1129 lines where the file has 1127, so exactly 2 NUL bytes, both localizing to line 308 — inside the pre-existing sc-14-7/sc-14-8 block. This sprint's additions (`assertFlipPrerequisitesStated` at `:949-978`, five tests at `:1092-1126`) contain zero NUL bytes. The separator is neither a space nor Unicode whitespace: the probes `a\.join\(" "\)` and `a\.join\("\s"\)` both return zero matches while `compare\(a\.join` matches once.

This is the same signature sprint 4's audit found in `src/pge/registry/reducers.ts` (`rg` counts 638 against 636 real lines = exactly 2 NUL bytes). **Two files now confirmed.** Tracked as a separate task covering both.

## Approved areas

- `docs.test.ts:217` — `REPO_ROOT` derives from `fileURLToPath(new URL("../../../", import.meta.url))`, so no machine-specific path is committed.
- `docs.test.ts:410-442` — `withNode`/`withExtraNode`/`withoutNode` build spread-based copies re-validated through `NodeSchema.parse`, never touching the committed artifact.
- `docs/pge-graph.md` — zero matches for `/Users/`, `/home/`, PRIVATE KEY blocks, or `sk-`/`ghp_`/`xox`/`AKIA` token shapes. Every citation in the new closing record is repo-relative.
- `docs/pge-graph.md` and `conformance.engines.test.ts` — both free of NUL bytes and fully scanner-readable (conformance.engines.test.ts: 516 rg lines against 516 real).
- `docs/sprints/sprint-spec-20260812-terminal-vocabulary-6.md` — 205 rg lines against 205 real; no NUL bytes, no leaked paths or credentials.
