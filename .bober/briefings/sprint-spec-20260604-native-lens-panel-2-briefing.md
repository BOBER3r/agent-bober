# Sprint Briefing: Lens-aware evaluator agent modes + sync gate

**Contract:** sprint-spec-20260604-native-lens-panel-2
**Generated:** 2026-06-04T05:00:00Z

---

## 0. Disk State Check (answers contract C3 starting point)

`diff agents/bober-evaluator.md .claude/agents/bober-evaluator.md` → **IDENTICAL on disk right now.**
The two files are byte-identical at this moment, even though `.claude/agents/bober-evaluator.md`
shows as modified vs HEAD in git status (a prior unrelated working-tree change touched it, but it
currently matches the `agents/` source). After you edit `agents/bober-evaluator.md` they will DIVERGE
until you re-copy. The final step is therefore `cp agents/bober-evaluator.md .claude/agents/bober-evaluator.md`.

---

## 1. Target Files

### agents/bober-evaluator.md (modify — ADD ONE SECTION ONLY)

This is a 759-line MARKDOWN agent definition (not TS). The contract is strict: the new section
is **purely additive**. No deletion or edit of any existing line (C2; evaluatorNotes require a
`git diff` that is additive-only — a single new section, no other hunks).

**Frontmatter (lines 1-20)** — DO NOT TOUCH. `name: bober-evaluator`, `tools:` list (Read/Bash/Grep/Glob + playwright), `model: sonnet`.

**Subagent Context block (lines 24-66)** — defines the EvalResult JSON output shape (lines 38-61):
```markdown
## Subagent Context

You are being **spawned as a subagent** by the Bober orchestrator. This means:
... (lines 26-37) ...
- Your **response text** back to the orchestrator must be the structured EvalResult JSON. Use EXACTLY this format:

```json
{ "evalId": ..., "overallResult": "pass | fail", "score": {...}, "strategyResults": [...], "criteriaResults": [...], ... }
```
... (lines 63-65) ...

---     ← line 66 (closing horizontal rule of the Subagent Context block)
```

**IRON LAW (lines 70-80)** immediately follows the line-68 intro paragraph:
```markdown
68 You are the **Evaluator** in the Bober Generator-Evaluator multi-agent harness. ...
70 **IRON LAW:**
72 ```
73 NO PASS WITHOUT INDEPENDENT VERIFICATION OF EVERY SUCCESS CRITERION
74 ```
... <EXTREMELY-IMPORTANT> block lines 78-80 ...
82 ## Runtime Tool Surface (graph-gated — ADR-5 / ADR-8)
```

**RECOMMENDED INSERTION POINT — between line 66 and line 68.**
Insert the new `## Panel / Lens Mode (opt-in)` section right after the `---` that closes the
Subagent Context block (line 66) and before the line-68 "You are the **Evaluator**..." paragraph.

Why here:
- generatorNotes say "near the top of the body (after the Subagent Context block, before or after the IRON LAW)".
- The Subagent Context block already defines the EvalResult output shape (lines 38-61), so a mode
  section that says "in addition to your normal EvalResult, also emit `{lens,passed,summary}`" reads
  naturally immediately after it.
- It sits BEFORE the IRON LAW (line 70), so the IRON LAW and every downstream Process step stay
  byte-identical and remain the MODE:full default behavior.

The new section should END with its own `---` horizontal rule so the existing line-68 paragraph
keeps a blank line + rule above it exactly as the other sections do (every section in this file is
separated by a `---` rule, e.g. lines 8, 40, 66).

**Imports this file uses:** none (markdown).
**Imported by (read at runtime):**
- `src/orchestrator/agent-loader.ts` family loads agent markdown (see `agent-loader.test.ts`).
- The drift/sync vitest gate will read it from disk (see §6).

**Test file:** the sync gate (§6) — extend `src/orchestrator/lens-panel-parity.test.ts`.

---

### .claude/agents/bober-evaluator.md (modify — REGENERATE as exact copy)

Not hand-edited. It is a straight distribution copy of `agents/bober-evaluator.md`.
After editing the source, regenerate with: `cp agents/bober-evaluator.md .claude/agents/bober-evaluator.md`
Must end byte-identical (C3).

---

### src/orchestrator/lens-panel-parity.test.ts (modify — EXTEND with sync gate) — RECOMMENDED

Contract C4 allows either extending this file OR creating `src/orchestrator/agent-sync.test.ts`.
**Recommendation: EXTEND `lens-panel-parity.test.ts`.** It is already the "parity / drift gate" file,
already imports `readFile` from `node:fs/promises`, already uses the `new URL("../../...", import.meta.url)`
idiom, and is named for exactly this purpose. Adding a second `describe` block keeps all native-panel
drift gates in one place. `agent-sync.test.ts` does not yet exist (confirmed via `ls`).

**Current full contents (19 lines) — add a NEW describe block below it, do not modify existing:**
```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolveLensFocus } from "./eval-lenses.js";

// ── Lens-panel drift gate ──────────────────────────────────────────

const BUILT_IN_LENSES = ["correctness", "security", "regression", "quality"] as const;

describe("lens-panel.md drift gate", () => {
  it("embeds every resolveLensFocus fragment verbatim", async () => {
    const md = await readFile(
      new URL("../../skills/shared/lens-panel.md", import.meta.url),
      "utf-8",
    );
    for (const lens of BUILT_IN_LENSES) {
      expect(md).toContain(resolveLensFocus(lens));
    }
  });
});
```

**Add this new block (READS BOTH agent files, asserts byte-identical):**
```ts
// ── Evaluator agent copy sync gate ─────────────────────────────────

describe("bober-evaluator.md agent-copy sync gate", () => {
  it("keeps agents/ and .claude/agents/ copies byte-identical", async () => {
    const source = await readFile(
      new URL("../../agents/bober-evaluator.md", import.meta.url),
      "utf-8",
    );
    const claudeCopy = await readFile(
      new URL("../../.claude/agents/bober-evaluator.md", import.meta.url),
      "utf-8",
    );
    expect(claudeCopy).toBe(source);
  });
});
```

URL resolution check: the test lives in `src/orchestrator/`, so `../../` resolves to the repo root.
`new URL("../../agents/bober-evaluator.md", import.meta.url)` → `<root>/agents/bober-evaluator.md`.
`new URL("../../.claude/agents/bober-evaluator.md", import.meta.url)` → `<root>/.claude/agents/bober-evaluator.md`.
Both are correct (this matches the existing `../../skills/shared/lens-panel.md` resolution at line 12).

---

## 2. Patterns to Follow

### Test-reads-committed-file via node:fs/promises + import.meta.url URL
**Source:** `src/orchestrator/lens-panel-parity.test.ts`, lines 2 and 11-14
```ts
import { readFile } from "node:fs/promises";
...
const md = await readFile(
  new URL("../../skills/shared/lens-panel.md", import.meta.url),
  "utf-8",
);
```
**Rule:** Read committed files in tests with `readFile(new URL("../../<path>", import.meta.url), "utf-8")`.
No `fs.readFileSync` (principles.md line 42: no synchronous fs). Use `.toBe()` for the byte-identical assertion.

### Unicode box-drawing section headers in tests
**Source:** `src/orchestrator/lens-panel-parity.test.ts`, line 5 (`// ── Lens-panel drift gate ──────────`)
and `src/orchestrator/evaluator-agent.test.ts`, line 20 (`// ── Mock heavy dependencies ────────`)
**Rule:** Separate logical sections with `// ── Name ──────` headers (principles.md line 32).

### ESM .js specifiers on relative imports
**Source:** `src/orchestrator/lens-panel-parity.test.ts`, line 3 (`from "./eval-lenses.js"`)
**Rule:** All relative imports carry the `.js` extension (principles.md line 27). The new sync-gate
block needs NO new import — `readFile` and `describe/it/expect` are already imported in the file.

### Markdown section separation by `---` rule
**Source:** `agents/bober-evaluator.md` lines 8, 40, 66 (every major block ends with a `---` rule)
**Rule:** Frame the new `## Panel / Lens Mode (opt-in)` section so it ends with a `---` line, matching
the document's existing rhythm and leaving line 68's paragraph visually unchanged.

### Markdown reference to the canonical lens fragments (do NOT re-list fragments)
**Source:** `skills/shared/lens-panel.md` lines 10-38 (the canonical "Lens Focus Fragments" section)
and `src/orchestrator/lens-panel-parity.test.ts` line 16 (`resolveLensFocus(lens)`).
**Rule:** The MODE section must POINT to `skills/shared/lens-panel.md` for the focus fragments
("correctness / security / regression / quality, with a generic fallback for any custom lens name")
and reference the `resolveLensFocus(lens)` naming — do NOT copy the fragment strings into the agent
(copying them would create a second drift surface the gate does not cover).

---

## 3. Existing Utilities — DO NOT Recreate

This sprint edits markdown + adds a file-equality test; almost no code utilities apply. Reviewed
`src/utils/`, `src/orchestrator/`, and the lens stack — relevant items:

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `resolveLensFocus` | `src/orchestrator/eval-lenses.ts` (imported `./eval-lenses.js`) | `(lens: string): string` | Returns the focus fragment for a lens; REFERENCE this name in the MODE section, do not re-implement. |
| `readFile` | `node:fs/promises` (used `lens-panel-parity.test.ts:2`) | `(path|URL, encoding): Promise<string>` | Async file read for the sync gate. Do NOT add `fs.readFileSync`. |
| `lensVerdicts` shape | `skills/shared/lens-panel.md:94-100` | `Array<{lens:string; passed:boolean; summary:string}>` | The per-lens verdict shape MODE:lens:<name> must emit `{lens,passed,summary}`. |
| EvalResult JSON shape | `agents/bober-evaluator.md:38-61` (and Step 7, 397-458) | (JSON) | The agent's existing output contract; MODE:lens adds ONE verdict object alongside it, does not replace it. |

Utilities reviewed: `src/utils/`, `src/orchestrator/` (eval-lenses, reconciler) — no new helper is
needed; the sync gate uses only `readFile` + `expect().toBe()`.

---

## 4. Prior Sprint Output

### Sprint 1 (commit 0dc9cd8): Canonical lens-panel protocol + drift gate
**Created:** `skills/shared/lens-panel.md` — the single source of truth for the 4 verbatim lens
fragments (correctness/security/regression/quality, lines 16-38), the split fan-out + majority-vote/
fail-closed protocol, and the `lensVerdicts: Array<{lens,passed,summary}>` output shape (lines 89-100).
**Created:** `src/orchestrator/lens-panel-parity.test.ts` — drift gate reading the markdown via
`readFile(new URL("../../skills/shared/lens-panel.md", import.meta.url),"utf-8")` and asserting
`md.includes(resolveLensFocus(lens))`.
**Also:** made `lensVerdicts` optional on `EvalResultSchema`.
**Connection to this sprint:**
- The MODE:lens:<name> verdict object MUST use the `{lens, passed, summary}` shape that Sprint 1
  defined (`lens-panel.md:94-100`).
- The MODE section REFERENCES `skills/shared/lens-panel.md` for the fragment definitions rather than
  re-listing them — Sprint 1 made that file canonical.
- The sync gate you add lives alongside (and is recommended to extend) Sprint 1's
  `lens-panel-parity.test.ts`, reusing its exact `readFile`/URL idiom.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere, `.js` specifiers** (line 27) — relative imports end in `.js`.
- **`import type`** (line 35) — consistent-type-imports is enforced (not needed here; no new types).
- **No synchronous fs** (line 42) — use `node:fs/promises` `readFile`, never `readFileSync`.
- **Unicode section headers** `// ── Name ──────` (line 32).
- **Tests colocated** `*.test.ts` next to source (line 20) — the gate already lives in `src/orchestrator/`.
- **Conventional commit** `bober(sprint-N): description` (line 34). Use the exact message from
  generatorNotes: `bober(sprint-2): add lens-aware evaluator agent modes + sync gate`.

### Architecture Decisions
`.bober/architecture/` exists in the working tree but no ADR is directly relevant to a markdown edit
+ file-equality test. The agent references ADR-5/ADR-8 (graph-gated tools) at line 82 — leave untouched.

### Other Docs
`skills/shared/lens-panel.md` is the canonical reference the MODE section must cite (see §1, §2, §4).

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `src/orchestrator/lens-panel-parity.test.ts` (full file shown in §1)
```ts
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";

describe("bober-evaluator.md agent-copy sync gate", () => {
  it("keeps agents/ and .claude/agents/ copies byte-identical", async () => {
    const source = await readFile(new URL("../../agents/bober-evaluator.md", import.meta.url), "utf-8");
    const claudeCopy = await readFile(new URL("../../.claude/agents/bober-evaluator.md", import.meta.url), "utf-8");
    expect(claudeCopy).toBe(source);
  });
});
```
**Runner:** vitest
**Assertion style:** `expect(...).toBe(...)` (strict referential/value equality on two strings)
**Mock approach:** none — reads real committed files (principles.md line 44: no fs mocks; create real state / read real files)
**File naming:** `*.test.ts`
**Location:** colocated in `src/orchestrator/`

### E2E Test Pattern
Not applicable — no UI in this sprint.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `.claude/agents/bober-evaluator.md` | `agents/bober-evaluator.md` | high | Must be re-copied to stay byte-identical or the new sync gate fails. |
| `src/orchestrator/lens-panel-parity.test.ts` | both agent md files (after extend) | low | New describe block must compile + pass; existing fragment gate must stay green. |
| `src/orchestrator/agent-loader.ts` / `agent-loader.test.ts` | parses agent md frontmatter | low | Frontmatter (lines 1-20) is untouched, so loader/test stay valid. Verify by running the suite. |

### Existing Tests That Must Still Pass
- `src/orchestrator/lens-panel-parity.test.ts` — Sprint 1 fragment-drift gate; verify the existing
  `describe("lens-panel.md drift gate")` still passes after you append the new block.
- `src/orchestrator/agent-loader.test.ts` — loads/parses agent markdown; the additive section must not
  break YAML frontmatter parsing (it won't — you insert in the body, not the frontmatter).
- `src/orchestrator/evaluator-agent.test.ts` — exercises the panel evaluator path (mocked LLM);
  unaffected by prose changes but must stay green.
- `src/orchestrator/eval-lenses.test.ts` — `resolveLensFocus` tests; unaffected (no eval-lenses change, a nonGoal).

### Features That Could Be Affected
- **Sprint 3 (next)** consumes the MODE the agent now understands (orchestrator passes MODE in the
  spawn prompt). The `{lens,passed,summary}` shape you document must match `lens-panel.md:94-100`
  so Sprint 3 can collect verdicts into `lensVerdicts`.
- **Default (off-path) evaluation** — MODE:full MUST be defined as the no-mode default so existing
  evaluator behavior is byte-identical when no MODE is passed (C2). This is the regression-critical bit.

### Recommended Regression Checks
After implementation, the Generator MUST run and verify exit 0 / green:
1. `git diff agents/bober-evaluator.md` → confirm the diff is PURELY ADDITIVE (one new section; no
   deletions/edits to any pre-existing line). This is the C2 gate.
2. `diff agents/bober-evaluator.md .claude/agents/bober-evaluator.md` → must print nothing (byte-identical, C3).
3. `npx vitest run src/orchestrator/lens-panel-parity.test.ts` → both describe blocks green.
4. `npx tsc --noEmit` → exit 0.
5. `npm run build` → exit 0.
6. `npx eslint src/` → exit 0.
7. `npx vitest run` → full suite green, only the documented pre-existing skipped baseline tolerated.
8. Confirm no `SKILL.md` and no `.claude/commands/*.md` were touched (nonGoals / outOfScope).

---

## 8. Implementation Sequence

1. **Edit `agents/bober-evaluator.md`** — insert ONE `## Panel / Lens Mode (opt-in)` section between
   line 66 (the `---` closing the Subagent Context block) and line 68 (`You are the **Evaluator**...`).
   Document the three modes:
   - MODE:full — default applied when the spawn prompt specifies no mode; behave EXACTLY as the rest
     of this document specifies (off-path, byte-identical behavior).
   - MODE:deterministic — run the configured `evaluator.strategies` only; report `strategyResults` +
     pass/fail of strategy-backed criteria; skip qualitative/manual lens judgment; `passed` reflects
     only deterministic strategies.
   - MODE:lens:<name> — do NOT re-run the strategy suite; judge only the qualitative/manual criteria
     through the named lens focus (fragments defined in `skills/shared/lens-panel.md` —
     correctness/security/regression/quality + generic fallback; via `resolveLensFocus`); in addition
     to the normal EvalResult emit one `{ lens: '<name>', passed: <bool>, summary: '<one-line>' }`.
   End the section with a `---` rule. Do NOT alter any existing line.
   - Verify: `git diff agents/bober-evaluator.md` is additive-only.
2. **Regenerate `.claude/agents/bober-evaluator.md`** — `cp agents/bober-evaluator.md .claude/agents/bober-evaluator.md`.
   - Verify: `diff agents/bober-evaluator.md .claude/agents/bober-evaluator.md` prints nothing.
3. **Extend `src/orchestrator/lens-panel-parity.test.ts`** — append the new
   `describe("bober-evaluator.md agent-copy sync gate")` block (§1 / §6). No new imports needed.
   - Verify: `npx vitest run src/orchestrator/lens-panel-parity.test.ts` green.
4. **Run full verification** — `npx tsc --noEmit`, `npm run build`, `npx eslint src/`, `npx vitest run`.
5. **Commit** — stage ONLY the three files with explicit paths (never `git add -A`):
   `git add agents/bober-evaluator.md .claude/agents/bober-evaluator.md src/orchestrator/lens-panel-parity.test.ts`
   then `bober(sprint-2): add lens-aware evaluator agent modes + sync gate`. Stay on the feature branch.

---

## 9. Pitfalls & Warnings

- **Additive-only is hard-gated (C2).** Do not reword, reindent, or "tidy" any existing line in
  `agents/bober-evaluator.md`. The evaluator will run `git diff` and fail on ANY non-additive hunk.
- **`.claude/agents/bober-evaluator.md` already shows modified vs HEAD** in git status, but currently
  matches the source on disk. Don't be confused — after you edit the source, you MUST re-copy or the
  sync gate fails. The two staged files together must end byte-identical.
- **Do NOT re-list the lens fragments** in the agent. Reference `skills/shared/lens-panel.md` /
  `resolveLensFocus`. Copying the strings creates a second drift surface the gate cannot catch and
  risks the Sprint-1 fragment gate's intent.
- **Use `{lens, passed, summary}` exactly** (from `lens-panel.md:94-100`) — not `{lens, pass, note}` or
  any variant. Sprint 3 collects these into `lensVerdicts`.
- **Do NOT touch the frontmatter (lines 1-20)** or `agent-loader` will see changed metadata; tests
  parse the YAML.
- **nonGoals / outOfScope:** do NOT edit `src/orchestrator/eval-lenses.ts`, `reconciler.ts`,
  `eval-result.ts`, any `SKILL.md`, or any `.claude/commands/*.md`. This sprint touches exactly three files.
- **No `readFileSync`** in the test (principles.md line 42) — use `node:fs/promises` `readFile` (already imported).
- **`.js` specifier + unicode header** in the test block, per principles. The block needs no new import.
- **Commit hygiene:** explicit paths only, never `git add -A`; never commit on `main`.
