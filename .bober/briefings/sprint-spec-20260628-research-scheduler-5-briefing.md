# Sprint Briefing: Morning digest artifact for the Telegram bot

**Contract:** sprint-spec-20260628-research-scheduler-5
**Generated:** 2026-06-30T00:00:00.000Z

> Sprint 5 of 5 (FINAL). Add `src/research/digest.ts` (`buildDigest(since, now, deps)` + dual md/json render + write) and a `research digest --since <iso>` subcommand. Content artifact only — NO Telegram transport/rendering. Empty window => explicit "no new research" digest (both files still written). Non-sensitive summary content only.

---

## 0. KEY DECISION — what `collectRuns(since, now)` reads

**RECOMMENDATION: read VAULT RESEARCH NOTES, not hub Findings.**

A Sprint-2 run produces BOTH (a) a vault note and (b) a hub Finding (`src/research/runner.ts:181-203`). Either could feed the digest, but the note is the faithful per-run source:

| Need | Vault note (frontmatter) | Hub Finding |
|------|--------------------------|-------------|
| Window filter on run time | `frontmatter.generatedAt` = injected `now` per run (`note-writer.ts:63`) — exact | `surfacedAt` = `now` (`runner.ts:133`) — exact, BUT see dedup row |
| 1 artifact == 1 run | YES — each run writes a NEW dated file `<vaultRoot>/research/<YYYY-MM-DD>-<marker>.md` (`runner.ts:186-190`, `note-writer.ts:23-26`); re-runs never overwrite prior runs | NO — Findings are content-deduped by `sha256(domain\|title\|kind)` (`finding-store.ts:121-126`, `runner.ts:104-108`); re-running the same question SUPERSEDES the old Finding, so `readFindings` only returns the LATEST run → undercounts the window |
| Job title | `frontmatter.title` = `"Research — <question>"` (`note-writer.ts:60`) | `finding.title` = `"Research: <question>"` (`runner.ts:118`) |
| Source link | the note PATH itself (a real on-disk artifact) | no path field — nothing to link |
| Domain isolation | notes live under `<vaultRoot>/research/` only | hub scope mixes gmail/medical/coding Findings — must filter by `tags` containing `"research"` |
| No SQLite | pure fs (`listNotes`+`readNote`) | must open a `FactStore` |

**Conclusion:** the real `collectRuns` = `listNotes(join(vaultRoot,"research"))` → `readNote` each → keep notes whose `frontmatter.generatedAt` is in `[since, now]` → map to a `DigestRun`. The note PATH is the `source` link; the `topFinding` is derived from the note frontmatter (`title`/`question`) — **title/summary only, never raw body values** (research doc L141, principles L42 fs-discipline). Findings are deduped + historyless + path-less, so they would silently drop runs from a window — wrong for an aggregator.

**`buildDigest` boundary (crisp):** `buildDigest` takes `deps = { collectRuns }` so it is unit-testable with a FAKE `collectRuns` returning `DigestRun[]` — NO vault, NO FactStore, NO notes needed in the test. Only the CLI binds the REAL note-reading `collectRuns`.

---

## 1. Target Files

### src/research/digest.ts (create)

**Directory pattern:** `src/research/` files are kebab/lowercase single-word `.ts` modules (`note-writer.ts`, `runner.ts`, `job-store.ts`, `scheduler.ts`). Each starts with a block doc-comment stating PURITY / clock discipline.

**Most similar existing files to mirror:**
- Markdown render half → `src/hub/priority-md.ts` (PURE string builder: `lines: string[]` + `lines.join("\n")`).
- JSON write half → `src/fleet/index.ts:61-76` (`writeSynthesis`: `JSON.stringify(x, null, 2) + "\n"`).
- Per-run shape + clock discipline → `src/research/note-writer.ts` (injected `now`, never wall-clock).

**Structure template (based on those files):**
```ts
/**
 * Research digest builder — aggregates in-window research runs into a
 * dual markdown+JSON artifact for the Telegram bot (sibling spec) to push.
 *
 * Clock discipline: `now`/`since` are injected ISO strings — never new Date() here.
 * Non-sensitive summary content only (titles/summaries; no raw body values).
 */
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { ensureDir } from "../state/helpers.js";        // generatorNotes: use THIS ensureDir
import { listNotes, readNote } from "../vault/note-io.js";

// ── Types ─────────────────────────────────────────────────────────────
export interface DigestRun {
  title: string;        // job title — note frontmatter.title
  topFinding: string;   // non-sensitive one-line summary (title/question, NOT raw values)
  generatedAt: string;  // ISO — note frontmatter.generatedAt
  source: string;       // note path / link
}
export interface Digest {
  since: string;
  now: string;
  generatedAt: string;  // = now
  runs: DigestRun[];
}
export interface DigestDeps {
  collectRuns: (since: string, now: string) => Promise<DigestRun[]>;
  digestsDir: string;   // e.g. <root>/.bober/research/digests — injected; temp dir in tests
}

// ── Pure render (testable without fs) ─────────────────────────────────
export function renderDigestMarkdown(d: Digest): string { /* lines[].join("\n") */ }

// ── buildDigest: collect -> render both -> write both ─────────────────
export async function buildDigest(
  since: string, now: string, deps: DigestDeps,
): Promise<{ digest: Digest; mdPath: string; jsonPath: string }> {
  const runs = await deps.collectRuns(since, now);
  const digest: Digest = { since, now, generatedAt: now, runs };
  const date = now.slice(0, 10);                       // YYYY-MM-DD — see §2
  await ensureDir(deps.digestsDir);
  const mdPath = join(deps.digestsDir, `${date}.md`);
  const jsonPath = join(deps.digestsDir, `${date}.json`);
  await writeFile(mdPath, renderDigestMarkdown(digest), "utf-8");
  await writeFile(jsonPath, JSON.stringify(digest, null, 2) + "\n", "utf-8");
  return { digest, mdPath, jsonPath };
}

// ── Real note-backed collector (bound only by the CLI) ────────────────
export async function collectRunsFromVault(
  vaultRoot: string, since: string, now: string,
): Promise<DigestRun[]> { /* listNotes(join(vaultRoot,"research")) -> readNote -> filter generatedAt -> map */ }
```
**Empty-window rule (sc-5-3):** when `runs.length === 0`, `renderDigestMarkdown` MUST emit a body that explicitly states no new research was produced in the window (e.g. `_No new research was produced in this window._`) — do NOT throw and do NOT skip writing; both files are still written by `buildDigest`.

---

### src/cli/commands/research.ts (modify)

**Relevant sections — register a new `digest` subcommand on `researchCmd` (alongside `run`/`tick`, after line 390):**
```ts
// existing imports to extend (lines 30-48): add the digest module
import { buildDigest, collectRunsFromVault } from "../../research/digest.js";
import { join } from "node:path";
```
**Subcommand pattern to mirror — `research run` action (lines 196-275), esp. clock + root + vaultRoot:**
```ts
researchCmd
  .command("digest")
  .description("Aggregate research runs in [since, now] into a md+json digest artifact")
  .option("--since <iso>", "Window start ISO (default: 24h before now)")
  .action(async (opts: { since?: string }) => {
    const projectRoot = await resolveRoot();          // research.ts:52-55
    try {
      // Stamp wall-clock ONLY here — clock discipline (research.ts:211-212, principles L31-ish)
      const now = new Date().toISOString();
      const since = opts.since ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const vaultRoot = projectRoot;                  // same default as `research run` (research.ts:214)
      const digestsDir = join(projectRoot, ".bober", "research", "digests");
      const res = await buildDigest(since, now, {
        collectRuns: (s, n) => collectRunsFromVault(vaultRoot, s, n),
        digestsDir,
      });
      process.stdout.write(res.mdPath + "\n" + res.jsonPath + "\n");
    } catch (err) {
      process.stderr.write(
        chalk.red(`research digest failed: ${err instanceof Error ? err.message : String(err)}\n`),
      );
      process.exitCode = 1;                            // CLI handlers NEVER throw (research.ts:8-9, 126-133)
    }
  });
```
**Imports this file already uses:** `chalk`, `Command`, `findProjectRoot` (research.ts:27-48). Keep the new fs work OUT of this file — `buildDigest` owns it (research.ts:21-25 fs-boundary note; the `digest` command computes `since`/`now`/paths only).

**Imported by:** `src/cli/index.ts` (calls `registerResearchCommand`). The default-no-`--since` path uses the wall clock at the `.action` boundary ONLY.

**Test file:** `src/cli/commands/research.test.ts` (EXISTS) — extend it OR rely on `src/research/digest.test.ts`. The CLI test whole-module-mocks `../../utils/fs.js` (research.test.ts:32-34) — `digest.ts` must NOT import from `utils/fs.js`; use `ensureDir` from `state/helpers.ts` (already the generatorNotes instruction) so that mock stays stable.

---

### src/research/digest.test.ts (create)

Mirror `src/research/runner.test.ts` temp-dir lifecycle (no fs mocks; principles L44). Inject a FAKE `collectRuns` — no real notes needed.

---

## 2. Patterns to Follow

### Filename date = injected-`now`.slice(0,10) => YYYY-MM-DD
**Source:** `src/research/note-writer.ts:23-26`
```ts
export function researchNotePath(vaultRoot: string, marker: string, now: string): string {
  const date = now.slice(0, 10); // YYYY-MM-DD
  return join(vaultRoot, "research", `${date}-${marker}.md`);
}
```
Also `src/medical/audit.ts:31` (`const date = tIso.slice(0, 10); // "2026-06-16"`) and `src/medical/research/research-note.ts:24`.
**Rule:** Derive the `<date>` in `<date>.md`/`<date>.json` from `now.slice(0,10)` (the INJECTED ISO) — never `new Date()` inside the module.

### PURE markdown render via lines[] + join("\n")
**Source:** `src/hub/priority-md.ts:34-78`
```ts
const lines: string[] = ["---"];
lines.push(`generatedAt: ${now.toISOString()}`);
// ... push rows / sections ...
return lines.join("\n");
```
**Rule:** Build the markdown body as a `string[]` and `join("\n")`; keep the renderer PURE (no fs). Escape table cells with a `cellValue` helper if you emit a table (priority-md.ts:20-22).

### JSON sibling artifact: stringify(…, null, 2) + "\n"
**Source:** `src/fleet/index.ts:61-76` (`writeSynthesis` → `.bober/fleet-synthesis.json`)
```ts
await writeFile(tmp, JSON.stringify(bundle, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
```
**Rule:** Machine-readable JSON = `JSON.stringify(digest, null, 2) + "\n"`. (Atomic tmp+rename is optional polish; a plain `writeFile` after `ensureDir` is sufficient for sc-5-2 — mirror `runner.ts:189-190`.)

### Async fs only; ensureDir before writeFile
**Source:** `src/research/runner.ts:189-190`
```ts
await mkdir(dirname(notePath), { recursive: true });
await writeFile(notePath, noteContent, "utf-8");
```
**Rule:** `node:fs/promises` only (principles L42). Call `ensureDir(deps.digestsDir)` once, then write both files.

### Reading vault notes (for the real collectRuns)
**Source:** `src/vault/note-io.ts:27-51`
```ts
export async function readNote(path: string): Promise<VaultNote> {       // { frontmatter, body, path }
  const raw = await readFile(path, "utf-8");
  return parseNote(raw, path);
}
export async function listNotes(vaultDir: string): Promise<string[]> {    // absolute paths of **/*.md
  return glob("**/*.md", { cwd: vaultDir, absolute: true, nodir: true });
}
```
`VaultNote = { frontmatter: Record<string, unknown>; body: string; path: string }` (`src/vault/types.ts:12-21`). Read `frontmatter["generatedAt"]`, `frontmatter["title"]`, `frontmatter["question"]` as `unknown` and narrow to `string`.
**Rule:** Filter with lexicographic ISO compare (`since <= generatedAt && generatedAt <= now`) — safe because all are `toISOString()` fixed-width (see `finding-store.ts:101-104` note). Skip notes whose `generatedAt` is missing/not a string.

### CLI subcommand + deps-injection + clock-at-boundary + never-throw
**Source:** `src/research/runner.ts` doc (research.ts:16-25) + `research run` action (research.ts:196-275)
**Rule:** `new Date().toISOString()` ONLY at `.action()`; handler sets `process.exitCode = 1` and returns on error (never throws); fs work lives in the module, not the command.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `ensureDir` | `src/state/helpers.ts:6` | `(dirPath: string): Promise<void>` | mkdir recursive — **USE THIS ONE** (generatorNotes); NOT `utils/fs.ts`'s (keeps CLI test's fs mock stable) |
| `ensureDir` (alt) | `src/utils/fs.ts:45` | `(path: string): Promise<void>` | duplicate; AVOID importing into digest.ts (CLI test mocks utils/fs) |
| `listNotes` | `src/vault/note-io.ts:49` | `(vaultDir: string): Promise<string[]>` | glob all `**/*.md` absolute paths under a dir — real collector enumerator |
| `readNote` | `src/vault/note-io.ts:27` | `(path: string): Promise<VaultNote>` | readFile + parse frontmatter → `{frontmatter,body,path}` |
| `parseFrontmatter` | `src/vault/frontmatter.ts:53` | `(raw: string): {frontmatter,body}` | underlying pure parser (used by readNote) |
| `readFindings` | `src/hub/finding-store.ts:45` | `(store: FactStore): Finding[]` | hub Findings — REJECTED as digest source (deduped/historyless; see §0) |
| `researchNotePath` | `src/research/note-writer.ts:23` | `(vaultRoot, marker, now): string` | canonical `<date>-<marker>.md` path — reference for the date-slice convention |
| `findProjectRoot` | `src/utils/fs.ts:58` | `(): Promise<string \| undefined>` | already used by research.ts:30 via `resolveRoot()` |
| `writeJson` | `src/utils/fs.ts:34` | `(path, data): Promise<void>` | generic JSON writer — optional; do not import into digest.ts (utils/fs mock); inline `writeFile` instead |

**Utilities reviewed:** `src/utils/`, `src/state/`, `src/vault/`, `src/hub/`, `src/fleet/` — the rows above are all that apply; no digest-rendering or window-filtering helper exists yet (confirmed: `src/research/digest.ts` does NOT exist).

---

## 4. Prior Sprint Output

### Sprint 2 (commit 20d42cb): runner + note-writer — THE DATA SOURCE
**Created/owns:** `src/research/runner.ts` (`runResearchJob`), `src/research/note-writer.ts` (`serializeResearchNote`, `researchNotePath`).
**Note shape on disk** (`note-writer.ts:58-69`, written at `runner.ts:186-190`): path `<vaultRoot>/research/<YYYY-MM-DD>-<marker>.md`; frontmatter `{ title:"Research — <q>", jobId, question, models:string[], generatedAt:<now>, domain, type:"research", status:"open" }`.
**Finding shape** (`runner.ts:112-137`): `{ id, domain, title:"Research: <q>", kind:"watch", urgency:2, severity:2, evidence:[label:snippet…], surfacedAt:<now>, tags:["research",…], status:"open" }`.
**Connection:** the digest's "run" = one produced research note. `collectRunsFromVault` enumerates `<vaultRoot>/research/*.md`, filters by `frontmatter.generatedAt ∈ [since, now]`, and maps each to a `DigestRun { title, topFinding, generatedAt, source=path }`.

### Sprint 4 (commit c8c4b53): scheduler/tick
**Created:** `src/research/scheduler.ts` (`tick`), wired in `research.ts:279-390`.
**Connection:** tick→digest integration is OPTIONAL/additive and OUT OF SCOPE here (contract nonGoals L40). Do NOT modify the runner/cadence/tick (nonGoals L39). The digest is produced on demand via the new CLI subcommand only.

### Sprint 2 dependency note
Contract `dependsOn` = `["sprint-spec-20260628-research-scheduler-2"]` only — the digest reads Sprint-2 output, nothing from Sprints 3/4 is required.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM + `.js` extensions** on every import (L27). Strict TS, zero type/lint errors are hard gates (L18-21).
- **`import type { … }`** for type-only imports — `consistent-type-imports` is enforced (L35). Prefix unused params with `_` (L36).
- **Zod for validation** (L29) — optional here; the Digest can be a plain interface, but a `DigestSchema`/`DigestRunSchema` is welcome and matches the codebase (`finding.ts:9`, `types.ts:33`).
- **No synchronous fs** — `node:fs/promises` only (L42). **No fs test mocks** — temp dirs + cleanup (L44).
- **Section comments** `// ── Name ──` (L32). Small single-purpose util modules (L33).

### Architecture / scope boundary
**Source:** research doc `research-20260627-knowledge-platform-landscape.md` L137-L141.
- Telegram is a **presentation adapter sequenced AFTER the hub** — it consumes the digest JSON and pushes it as a **silent scheduled message**. This sprint produces ONLY the content artifact.
- **PRIVACY (critical, L141):** Telegram bot messages are NOT end-to-end encrypted → digest is **non-sensitive summaries ONLY**, never raw PHI/financial detail. Keep `topFinding` to titles/one-line summaries; never copy raw note-body values into the digest.

### Other docs
No `CLAUDE.md`/`CONTRIBUTING.md` engineering guide beyond `.bober/principles.md` applies to `src/research/`.

---

## 6. Testing Patterns

### Unit Test Pattern — fs to a real temp dir (for buildDigest write assertions)
**Source:** `src/research/runner.test.ts:8-54`
```ts
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

let tmpRoot: string;
beforeEach(async () => { tmpRoot = await mkdtemp(join(tmpdir(), "bober-research-digest-")); });
afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }); });
```
**Suggested digest.test.ts cases (cover sc-5-1/2/3):**
```ts
const NOW = "2026-06-28T12:00:00.000Z";
const SINCE = "2026-06-27T12:00:00.000Z";
const TWO_RUNS: DigestRun[] = [
  { title: "Research — A", topFinding: "finding A", generatedAt: NOW, source: "/v/research/2026-06-28-a.md" },
  { title: "Research — B", topFinding: "finding B", generatedAt: NOW, source: "/v/research/2026-06-28-b.md" },
];

it("sc-5-1/sc-5-2: md lists both titles + top findings; json has 2-element runs array", async () => {
  const res = await buildDigest(SINCE, NOW, {
    collectRuns: async () => TWO_RUNS,
    digestsDir: join(tmpRoot, ".bober", "research", "digests"),
  });
  const md = await readFile(res.mdPath, "utf-8");
  expect(md).toContain("Research — A"); expect(md).toContain("Research — B");
  expect(md).toContain("finding A");    expect(md).toContain("finding B");
  const json = JSON.parse(await readFile(res.jsonPath, "utf-8"));
  expect(json.runs).toHaveLength(2);
  expect(res.mdPath.endsWith("2026-06-28.md")).toBe(true);   // date = now.slice(0,10)
});

it("sc-5-3: empty window -> no-new-research body + both files written", async () => {
  const res = await buildDigest(SINCE, NOW, {
    collectRuns: async () => [],
    digestsDir: join(tmpRoot, ".bober", "research", "digests"),
  });
  const md = await readFile(res.mdPath, "utf-8");
  expect(md.toLowerCase()).toContain("no new research");
  const json = JSON.parse(await readFile(res.jsonPath, "utf-8"));
  expect(json.runs).toEqual([]);
  // both files exist (readFile above would throw otherwise)
});
```
**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** dependency injection (fake `collectRuns`) — NO `vi.mock` for digest.ts; real temp-dir fs (principles L44). **File naming:** `digest.test.ts` collocated next to `digest.ts`. **Location:** co-located.

### CLI registration test (optional — sc-5-4 is build-verified)
**Source:** `src/cli/commands/research.test.ts:32-76`
```ts
vi.mock("../../utils/fs.js", () => ({ findProjectRoot: vi.fn() }));   // whole-module mock
function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();           // stop commander calling process.exit()
  registerResearchCommand(program);
  return program;
}
await program.parseAsync(["node", "bober", "research", "digest", "--since", SINCE], { from: "node" });
```
**Selector convention:** N/A (no E2E/Playwright for this CLI sprint). **CRITICAL:** because this test mocks `utils/fs.js`, `digest.ts` must import `ensureDir` from `state/helpers.ts` and must NOT import `utils/fs.js` — else the mock would break `ensureDir`/`writeJson`.

### E2E Test Pattern
Not applicable — this is a Node CLI/library sprint; no `playwright.config.ts` path is involved.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/commands/research.ts` | new `digest.ts` import + new subcommand | low | Additive — existing `job`/`run`/`tick` subcommands untouched; new `.command("digest")` registered after line 390 inside `registerResearchCommand` |
| `src/cli/index.ts` | `registerResearchCommand` | low | Signature unchanged (still `(program, overrides?)`) — no change needed |
| `src/research/runner.ts`, `note-writer.ts`, `scheduler.ts` | — | none | DO NOT modify (contract nonGoals L39) — digest only READS their note output |
| `src/hub/finding-store.ts` | — | none | Not touched (Findings rejected as source) |

### Existing Tests That Must Still Pass
- `src/cli/commands/research.test.ts` — exercises `job add/list/remove`, `run`, `tick` via `parseAsync`; must still pass after the new `digest` subcommand is registered (additive). Its `vi.mock("../../utils/fs.js")` is the reason `digest.ts` must avoid `utils/fs.js`.
- `src/research/runner.test.ts` — verifies note path/frontmatter (`generatedAt`, `title`) and Finding shape; confirms the fields `collectRunsFromVault` relies on. Must remain green (do not change runner/note-writer).
- `src/research/note-writer.test.ts` — locks the `<date>-<marker>.md` path + frontmatter contract the collector reads.
- `src/research/scheduler.test.ts` — Sprint-4 tick; unaffected (no tick integration here).

### Features That Could Be Affected
- **Telegram frontend (sibling spec-20260628-telegram-frontend)** — CONSUMER of `<date>.json`. Keep the JSON shape stable + documented: `{ since, now, generatedAt, runs: DigestRun[] }`. Non-sensitive content only (research doc L141).
- **research run/tick** — share `src/research/` + the vault `research/` dir; verify a digest run does not write into or read-corrupt `<vaultRoot>/research/*.md` (digest writes to `.bober/research/digests/` — a separate dir).

### Recommended Regression Checks (run after implementation)
1. `npm run build` — green (sc-5-4: digest module + subcommand compile).
2. `npx vitest run src/research/digest.test.ts` — new tests pass (sc-5-1/2/3).
3. `npx vitest run src/research/ src/cli/commands/research.test.ts` — prior research + CLI tests still pass.
4. `npx tsc --noEmit` (or the repo typecheck) — zero errors; verify `consistent-type-imports` (use `import type` for `DigestRun`/`Digest`/`VaultNote`).
5. Manual: `node dist/cli.js research digest --since 2026-06-01T00:00:00.000Z` writes `.bober/research/digests/<today>.md` + `.json` (or rely on the unit test for sc-5-2).

---

## 8. Implementation Sequence

1. **`src/research/digest.ts` — types** (`DigestRun`, `Digest`, `DigestDeps`).
   - Verify: `import type` used; `tsc` sees the interfaces.
2. **`src/research/digest.ts` — `renderDigestMarkdown(digest)`** (PURE; lines[]+join; empty-window "no new research" branch).
   - Verify: with 0 runs returns a body containing "no new research"; with N runs contains every `title` + `topFinding`.
3. **`src/research/digest.ts` — `buildDigest(since, now, deps)`** (collect via dep → render md + `JSON.stringify(...,null,2)+"\n"` → `ensureDir(deps.digestsDir)` → write both → return `{digest, mdPath, jsonPath}`; date=`now.slice(0,10)`).
   - Verify: both files exist under temp `digestsDir`; filenames `<YYYY-MM-DD>.{md,json}`.
4. **`src/research/digest.ts` — `collectRunsFromVault(vaultRoot, since, now)`** (real collector: `listNotes(join(vaultRoot,"research"))` → `readNote` → filter `frontmatter.generatedAt ∈ [since,now]` → map to `DigestRun`).
   - Verify: returns only in-window notes; tolerates missing/non-string `generatedAt` (skip).
5. **`src/cli/commands/research.ts` — register `digest --since <iso>`** (clock+`since` default at `.action` boundary; bind real `collectRunsFromVault`; never-throw → `process.exitCode=1`).
   - Verify: subcommand appears under `research`; no `utils/fs.js` import added to digest.ts.
6. **`src/research/digest.test.ts`** — fake `collectRuns` (2 runs + []) → assert md titles/findings, 2-element JSON `runs`, no-new-research body, both files written.
   - Verify: `npx vitest run src/research/digest.test.ts` green.
7. **Full verification** — `npm run build`; `npx vitest run src/research/ src/cli/commands/research.test.ts`; typecheck clean.

---

## 9. Pitfalls & Warnings

- **Two `ensureDir`s exist.** Use `ensureDir` from `src/state/helpers.ts:6` (generatorNotes). Do NOT import from `src/utils/fs.ts` — `research.test.ts:32-34` whole-module-mocks `utils/fs.js`, and an `ensureDir`/`writeJson` import from there would be `undefined` in CLI tests. Keep `digest.ts`'s `utils/fs.js` import surface empty.
- **Findings are deduped — do NOT use them as the run source.** `readFindings` (`finding-store.ts:45`) returns only the latest active row per `domain|title|kind`; two runs of the same question collapse to one Finding, undercounting the window. Use vault notes (see §0).
- **Clock discipline.** `digest.ts` must never call `new Date()`/`Date.now()`. `since`/`now` are injected; the 24h default + `now` are stamped ONLY at the CLI `.action` boundary (mirrors `research.ts:211-212`). Filename date = `now.slice(0,10)`, never wall-clock.
- **ISO lexicographic window compare.** `since <= generatedAt && generatedAt <= now` is safe only because all are `toISOString()` fixed-width (`finding-store.ts:101-104`). Skip notes whose `frontmatter.generatedAt` is absent or not a string.
- **`listNotes` globs `**/*.md` recursively** (`note-io.ts:49`). Scope it to `join(vaultRoot, "research")` so you do not sweep unrelated vault notes; still guard on frontmatter `type`/`generatedAt` shape.
- **Non-sensitive content (research doc L141).** Put titles/one-line summaries in the digest; never copy raw note-body model answers or any PHI/financial value. `topFinding` should be derived from `frontmatter.title`/`question`, not the body.
- **Empty window is NOT an error.** sc-5-3: still write BOTH files with an explicit "no new research" body and `runs: []`. Do not throw, do not skip the JSON.
- **JSON consumed by the Telegram sibling.** Keep the JSON shape `{ since, now, generatedAt, runs:[{title, topFinding, generatedAt, source}] }` stable + machine-parseable (`JSON.stringify(...,null,2)+"\n"`).
- **Additive CLI only.** Register `digest` inside `registerResearchCommand` after the `tick` block (research.ts:390); do not alter `job`/`run`/`tick`, the runner, cadence, or egress (nonGoals L39-40).
- **ESM `.js` extensions** on every relative import (principles L27): `../state/helpers.js`, `../vault/note-io.js`, `../../research/digest.js`.
