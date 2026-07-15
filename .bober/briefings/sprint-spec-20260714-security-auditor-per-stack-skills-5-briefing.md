# Sprint Briefing: Stack registry + knowledge index + selector + context resolver, wired into the finder (fixes G3)

**Contract:** sprint-spec-20260714-security-auditor-per-stack-skills-5
**Generated:** 2026-07-14T00:00:00Z

---

## 0. Orientation (read first)

This sprint replaces the **head-excerpt** stack resolver (the G3 defect) with a **retrieval** pipeline over the 8 authored skill files. You build four new modules under `src/orchestrator/security-knowledge/` and re-wire the auditor to use them.

Two facts that shape everything:

1. **The new skill dirs are `skills/bober.security-<stack>/`** — NOT the old `skills/bober.solidity/`. Verified present (all 8): `bober.security-{solidity,anchor,react,node,payments,igaming,dex-backend,generic}`. The OLD `STACK_SKILL_MAP` (`stack-knowledge.ts:62-66`) points at `bober.solidity`/`bober.anchor`/`bober.react` (3 entries, old names). The new registry maps to `bober.security-<stack>` (8 entries).
2. **`ALL_VULN_CLASSES` must stay exported from `stack-knowledge.ts`** — 6 files import it from there (parser.ts, security-scanners.ts, security-auditor-agent.ts, + 3 test files). Do NOT move it. Only the *resolver* logic leaves `stack-knowledge.ts`.

---

## 1. Target Files

### src/orchestrator/security-knowledge/registry.ts (create)

**Directory pattern:** sibling modules in `security-knowledge/` use named exports, `import type { ... } from "./signature.js"`, top-level `const` maps, pure functions. See `signature.ts:10` (union), `parser.ts:137` (object-with-methods export).
**Most similar existing file:** the `STACK_SKILL_MAP` + `detectStack` precedence logic at `stack-knowledge.ts:62-111` — port its *precedence* (blockchain/language before frontend/backend), retarget to `bober.security-*`, and extend 3→8.

Old precedence to preserve (`stack-knowledge.ts:86-98`):
```ts
const ordered: Array<string | undefined> = [
  stack.blockchain,   // checked first — most determinative
  stack.language,
  stack.frontend,
  stack.backend,
  stack.testing,
  stack.database,
  ...(stack.other ?? []),
];
```
Old keyword match (`stack-knowledge.ts:102-108`) returns first substring hit; **new registry** must map the matched keyword → one of 8 `SecurityStackId`s, and **unknown/absent/null → `"generic"` (never null, never throw)** (sc-5-1).

**Recommended keyword → SecurityStackId map** (substring match, lowercased, blockchain/language first):
| keyword substrings | SecurityStackId | skillName |
|---|---|---|
| `solidity`, `evm`, `foundry`, `hardhat` | `solidity` | `bober.security-solidity` |
| `anchor`, `solana` | `anchor` | `bober.security-anchor` |
| `react`, `next`, `vue`?/frontend→react floor | `react` | `bober.security-react` |
| `node`, `express`, `typescript`, `nest`, `fastify` | `node` | `bober.security-node` |
| `payment`, `stripe`, `pci` | `payments` | `bober.security-payments` |
| `igaming`, `casino`, `betting`, `wager` | `igaming` | `bober.security-igaming` |
| `dex`, `amm`, `orderbook` | `dex-backend` | `bober.security-dex-backend` |
| (no match) | `generic` | `bober.security-generic` |

`StackSecurityContext.stackLabel` must remain the **matched candidate string** (e.g. `"solidity"`), because `security-auditor-agent.ts:152` writes it into `SecurityAuditResult.stack` and `security-auditor-agent.test.ts:179` asserts `result.stack === "solidity"`.

---

### src/orchestrator/security-knowledge/index.ts (create)

> NOTE: this file is named `index.ts` but is **the KnowledgeIndex module, NOT a barrel**. Import it explicitly as `./security-knowledge/index.js`. Do not add re-exports of the sibling modules here.

**Most similar existing precedents:**
- Data-module shape: `eval-lenses.ts:4` `LENS_CATALOG` (module-level const catalog + a resolver fn). Cited by contract assumptions as the index precedent.
- Never-throw fs discipline: `readSkillSecurityExcerpt` at `stack-knowledge.ts:169-180`:
```ts
async function readSkillSecurityExcerpt(skillsRoot, skillName): Promise<string | null> {
  try {
    const filePath = join(skillsRoot, skillName, "SKILL.md");
    const content = await readFile(filePath, "utf-8");
    return extractSecurityExcerpt(content);
  } catch { return null; }   // <-- missing file => null, never throws
}
```
- Default skills root resolution: `stack-knowledge.ts:159-163`:
```ts
function defaultSkillsRoot(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return join(currentDir, "..", "..", "skills");   // NOTE: from security-knowledge/ this is "..","..","..","skills"
}
```
**Pitfall:** `index.ts` lives one directory deeper (`src/orchestrator/security-knowledge/`) than `stack-knowledge.ts` (`src/orchestrator/`). The default skills root from `index.ts` is `join(currentDir, "..", "..", "..", "skills")` (three `..`, not two). Verify with a real-file test.

**Structure template (recommended — instance with per-instance memo, ADR-7 per-process, no invalidation):**
```ts
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SecuritySignatureParser } from "./parser.js";
import type { SecuritySignature, SecurityStackId } from "./signature.js";
import { STACK_SKILL_MAP } from "./registry.js"; // stackId -> skillName, 8 entries

export class SecurityKnowledgeIndex {
  private cache: Map<SecurityStackId, SecuritySignature[]> | null = null;
  constructor(private readonly skillsRoot: string = defaultSkillsRoot()) {}

  async load(): Promise<void> {
    if (this.cache) return;                       // memoise: parse once
    const cache = new Map<SecurityStackId, SecuritySignature[]>();
    for (const { stackId, skillName } of STACK_SKILL_MAP_ENTRIES) {
      const rel = join(skillName, "SKILL.md");
      let md = "";
      try { md = await readFile(join(this.skillsRoot, rel), "utf-8"); }
      catch { cache.set(stackId, []); continue; } // missing => [], never throw
      cache.set(stackId, SecuritySignatureParser.parse(stackId, md, rel));
    }
    this.cache = cache;
  }
  forStack(stackId: SecurityStackId): SecuritySignature[] {
    return this.cache?.get(stackId) ?? [];
  }
  all(): SecuritySignature[] {
    return [...(this.cache?.values() ?? [])].flat();
  }
}
```
**Parser API to call** (`parser.ts:142`): `SecuritySignatureParser.parse(stackId, skillMarkdown, skillRelPath): SecuritySignature[]` — pure, total, never throws, drops malformed blocks. Iterate the **8 registry entries** (do NOT `readdir` the skills dir — that would sweep in `skills/bober.security-audit/` which is the orchestration skill, not a stack, and the parser needs a known `stackId` per file anyway).
**sc-5-2 test:** point a `skillsRoot` at the repo's real `skills/` dir; assert `forStack(id).length >= 6` for each of the 8 ids. Verified parseable counts: solidity 12, anchor **7**, react 8, node 12, payments 10, igaming 12, dex-backend 12, generic 14 (anchor is the tightest margin — do not break its 7 blocks).

---

### src/orchestrator/security-knowledge/selector.ts (create)

**Pattern precedent:** pure ranking, no fs — mirror the pure/total discipline of `parser.ts` and `eval-lenses.ts`. Signatures carry `keywords: string[]` (`signature.ts:46`, `parser.ts:116-118`) for exactly this.

**Recommended shape (pure, total — sc-5-3):**
```ts
export interface SelectInput {
  stackId: SecurityStackId;
  changedPaths: string[];
  diffKeywords: string[];
  topK: number;
  stackSignatures: SecuritySignature[];   // index.forStack(stackId)
  genericFloor: SecuritySignature[];      // index.forStack("generic") — ALWAYS included
}
export function selectSignatures(input: SelectInput): SecuritySignature[] { ... }
```
**Scoring:** `score = (stack membership) + (keyword overlap: signature.keywords ∩ diffKeywords) + (path hint: signature.keywords/id vs changedPaths basenames)`. Sort desc, cap at `topK`, then **concat the generic-floor set and dedup by `signatureId`** so the floor is ALWAYS present even if it didn't rank into topK. Recommend `topK` default 8 (assumptions: ~6-8, tunable via config later).
**sc-5-3 test:** craft `diffKeywords` matching a known signature's `keywords` (e.g. solidity `solidity.reentrancy-single-function` has `Keywords: reentrancy, call, checks-effects-interactions, nonReentrant` — `skills/bober.security-solidity/SKILL.md`), assert it ranks in AND `topK` is respected AND every generic-floor signature is present.

---

### src/orchestrator/security-knowledge/resolver.ts (create — replaces stack-knowledge.ts:198)

**Replaces:** `resolveStackSecurityContext` at `stack-knowledge.ts:198-225` (the head-excerpt version, G3 defect).

**New StackSecurityContext type** (extends the old `stack-knowledge.ts:20-29` with `stackId` + `signatures`; sc-5-4):
```ts
export interface StackSecurityContext {
  stackId: SecurityStackId;
  stackLabel: string;
  skillName: string;            // now "bober.security-<stack>" (widen from old 3-member union)
  taxonomy: VulnClass[];
  signatures: SecuritySignature[];
  promptFragment: string;       // NEVER empty
}
```
**New signature (injected collaborators — per generatorNotes + team-lead "input object"):**
```ts
export async function resolveStackSecurityContext(input: {
  stack: Stack | string | undefined;
  changedPaths: string[];
  diffKeywords?: string[];      // sprint 6 supplies real diff; [] for now
  index: SecurityKnowledgeIndex;
  registry?: ...;               // or import the map/fn from registry.js
  topK?: number;
  threatModelText?: string;     // optional, appended verbatim
}): Promise<StackSecurityContext>
```
**promptFragment renderer (NEVER empty — sc-5-4):** render each selected signature as `id — title`, `Invariant:`, then fenced `Unsafe:`/`Safe:` blocks. Append `threatModelText` when present. **Fallback:** if the selected set is empty (skills dir wholly missing), fall back to `resolveLensFocus("security")` (`eval-lenses.ts:24`) so it is never empty. The generic floor guarantees ≥6 signatures in the normal path, so the fragment is non-empty for all 8 stacks (G3 closed).

**resolver.test.ts (create — sc-5-4):** for each of the 7 stacks + generic, build an index with `skillsRoot` = repo `skills/`, call the resolver, assert `promptFragment` is non-empty AND contains a stack-appropriate token (e.g. solidity → `solidity.reentrancy` or `reentrancy`; generic → `sql-injection`; verified ids: `skills/bober.security-generic/SKILL.md` has `### sql-injection` at line 38, `### command-injection`, `### path-traversal`, … 14 blocks). Assert NO frontmatter/head-excerpt leakage (G3).

---

### src/orchestrator/security-auditor-agent.ts (modify)

**Current call site (line 14 import + line 79 call):**
```ts
// line 14:
import { resolveStackSecurityContext, ALL_VULN_CLASSES } from "./stack-knowledge.js";
// line 79:
const ctx = await resolveStackSecurityContext(config.project.stack);
```
**Change to:**
```ts
import { ALL_VULN_CLASSES } from "./stack-knowledge.js";                 // KEEP — 6 importers rely on this export
import { resolveStackSecurityContext } from "./security-knowledge/resolver.js";
import type { StackSecurityContext } from "./security-knowledge/resolver.js";
import { SecurityKnowledgeIndex } from "./security-knowledge/index.js";
...
const index = new SecurityKnowledgeIndex();        // or a memoised module singleton
await index.load();
const ctx = await resolveStackSecurityContext({
  stack: config.project.stack,
  changedPaths: contract.estimatedFiles,           // diff provider lands sprint 6
  diffKeywords: [],
  index,
});
```
**buildUserMessage stays almost unchanged** — it already takes `ctx.stackLabel`, `ctx.skillName`, `ctx.promptFragment` (called at `security-auditor-agent.ts:106-114`, folded in at `:210-215`). All three fields still exist on the new context. Only the *values* change (skillName is now `bober.security-<stack>`, fragment renders signatures). Keep `buildUserMessage`'s signature and body as-is.
**DO NOT TOUCH:** the fail-closed parser (`parseSecurityAuditResult`, `:270-345`), `deriveVerdict` usage (`:146`), the read-only curator toolset (`:68`), the scanner pre-filter block (`:86-104`). None of these interact with the resolver change.

**Imported by:** the auditor is invoked from the gate/pipeline (not in estimatedFiles scope this sprint) — only its *internal* resolver wiring changes; its public `runSecurityAudit` signature is unchanged, so no downstream caller breaks.
**Test file:** `src/orchestrator/security-auditor-agent.test.ts` (exists — see §7 for the exact assertions to update).

---

## 2. Patterns to Follow

### Named exports, `import type` for types, `.js` ESM extensions
**Source:** `signature.ts:1`, `parser.ts:1-4`, `stack-knowledge.ts:1-7`
```ts
import type { VulnClass, FindingSeverity } from "../security-audit-types.js";
import { ALL_VULN_CLASSES } from "../stack-knowledge.js";
import type { SecuritySignature, SecurityStackId } from "./signature.js";
```
**Rule:** every relative import ends in `.js`; types imported with `import type`; export named symbols (no default exports in this module).

### Never-throw fs loader
**Source:** `stack-knowledge.ts:169-180` (quoted in §1 index)
**Rule:** wrap every `readFile` in try/catch; a missing/unreadable skill resolves to `[]`, never a throw (sc-5-2).

### Pure/total parser-style guards
**Source:** `parser.ts:41-49, 142-155`
```ts
function isVulnClass(value: string): value is VulnClass {
  return (ALL_VULN_CLASSES as string[]).includes(value);
}
parse(stackId, skillMarkdown, skillRelPath): SecuritySignature[] {
  if (typeof skillMarkdown !== "string") return [];
  ...
}
```
**Rule:** the selector and registry must be pure and total — guard inputs, return a value for every input, never throw (sc-5-1 unknown→generic, sc-5-3 pure).

### Data-catalog module + resolver fn
**Source:** `eval-lenses.ts:4-28`
```ts
const LENS_CATALOG: Record<string, string> = { security: "Focus on injection ...", ... };
export function resolveLensFocus(lens: string): string {
  return LENS_CATALOG[lens] ?? `Evaluate specifically through the '${lens}' lens.`;
}
```
**Rule:** the registry's stack map is a module-level const table; resolution is a small pure fn with a total (generic) fallback.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `SecuritySignatureParser.parse` | `security-knowledge/parser.ts:142` | `(stackId, skillMarkdown, skillRelPath) => SecuritySignature[]` | The ONLY producer of signatures. Index calls this per file. Pure/total. |
| `ALL_VULN_CLASSES` | `stack-knowledge.ts:40` | `VulnClass[]` (17 entries) | Canonical taxonomy. Import from `stack-knowledge.js` — DO NOT redefine or move. |
| `resolveLensFocus` | `eval-lenses.ts:24` | `(lens: string) => string` | Generic security focus text; use ONLY as the never-empty fallback if the floor is empty. |
| `parseFrontmatter` | `vault/frontmatter.ts` | `(md) => { body, ... }` | Strips YAML frontmatter before block split. Parser already uses it (`parser.ts:145`); index doesn't call it directly (parser does). |
| `detectStack` (precedence) | `stack-knowledge.ts:77-111` | internal | REFERENCE the blockchain/language-first precedence; re-implement in registry.ts retargeted to 8 stacks (don't import — it returns the old 3-member type). |
| `SecurityStackId` union | `security-knowledge/signature.ts:10-18` | 8-member type | The registry's target type; import it. |
| `SecuritySignature` interface | `security-knowledge/signature.ts:27-50` | fields: stackId, signatureId, title, cwe, severity, vulnClass, invariant, unsafeExample, safeExample, keywords, skillRef | The record the index/selector/resolver pass around. |

Directories reviewed for reuse: `src/orchestrator/security-knowledge/` (signature, parser), `src/orchestrator/` (stack-knowledge, eval-lenses, security-scanners, security-audit-types), `src/vault/` (frontmatter). No generic `utils/`/`lib/`/`helpers/` module applies to retrieval — the reusable pieces are the four above.

---

## 4. Prior Sprint Output

### Sprints 1-4 (dependsOn: sprint-4)
**Created:** `security-knowledge/signature.ts` — exports `SecurityStackId` (8-member union, `:10`) and `SecuritySignature` interface (`:27`). **Connection:** registry maps to `SecurityStackId`; index/selector/resolver traffic in `SecuritySignature`.
**Created:** `security-knowledge/parser.ts` — exports `SecuritySignatureParser` with `.parse(stackId, markdown, skillRelPath)` (`:137-156`), pure/total, drops malformed blocks. **Connection:** the index's ONLY call into parsing; do not re-implement block parsing.
**Created:** `skills/bober.security-<stack>/SKILL.md` × 8 — each parses to ≥6 signatures (verified: 7-14 each). **Connection:** the index reads these 8 files; the registry names them (`bober.security-<stack>`).
**Widened (sprint 1):** `ALL_VULN_CLASSES` at `stack-knowledge.ts:40-58` (17 classes) + `VulnClass` union in `security-audit-types.ts` — lockstep asserted by `security-audit-types.test.ts:127`. **Connection:** taxonomy field on the context; the lockstep test MUST stay green (do not add/remove classes).

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` consulted for this briefing (not in the wiring path). The governing constraints are the contract's `nonGoals`/`stopConditions` and the fail-closed/read-only invariants in §9.

### Architecture Decisions
Referenced by the contract: `arch-20260712-security-audit-agent-team-architecture.md` (in `.bober/architecture/`) defines the `SecuritySignature` shape (sc-2-1), the 8 `SecurityStackId`s, and **ADR-7: the index is per-process memoised with NO runtime cache invalidation** (nonGoal[2] — do not add invalidation). ADR-4 (scanner AbortController time-boxing) is already implemented at `security-auditor-agent.ts:86-104` — do not touch.

### Other Docs
`skills/bober.security-generic/SKILL.md` contains the **"## Signature Block Format"** section which is the executable spec the parser mirrors (`parser.ts:6-37`). The generic skill is both the format spec AND the generic-floor signature source.

---

## 6. Testing Patterns

### Unit Test Pattern (resolver.test.ts, selector/index/registry tests)
**Source:** `stack-knowledge.test.ts:1-26` (real-file skillsRoot injection via tmpdir) and `parser.test.ts`
```ts
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

let skillsRoot: string;
beforeEach(async () => { skillsRoot = await mkdtemp(join(tmpdir(), "bober-...-test-")); });
afterEach(async () => { await rm(skillsRoot, { recursive: true, force: true }); });
async function writeSkill(name, content) {
  const dir = join(skillsRoot, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), content, "utf-8");
}
```
**Runner:** vitest. **Assertion style:** `expect(...).toBe/.toEqual/.toContain`. **Mock approach:** `vi.mock` (see security-auditor-agent.test.ts). **File naming:** `<module>.test.ts`, co-located.
**For the ≥6 real-file assertion (sc-5-2)** point `skillsRoot` at the REPO skills dir, not a tmpdir. Precedent: `stack-knowledge.test.ts:149-156` ("resolves without a skillsRoot override using the bundled package skills/ directory").

### Auditor end-to-end pattern (sc-5-5) — stub the agentic loop, capture userMessage
**Source:** `security-auditor-agent.test.ts:19-51, 285-297`
```ts
const loopSpy = vi.fn();
vi.mock("./agentic-loop.js", () => ({ runAgenticLoop: loopSpy }));
vi.mock("../providers/factory.js", () => ({ createClient: clientSpy }));
vi.mock("./model-resolver.js", () => ({ resolveModel: () => "model-test" }));
vi.mock("./agent-loader.js", () => ({ assembleSystemPrompt: vi.fn().mockResolvedValue("SYS") }));
vi.mock("./security-scanners.js", () => ({ runScannerPreFilter: scannerPreFilterSpy }));
vi.mock("./tools/index.js", async () => { /* real resolveRoleTools, stub graph off */ });
vi.mock("../state/security-audit-state.js", () => ({ saveSecurityAudit: saveSecurityAuditSpy }));
// ...
loopSpy.mockResolvedValueOnce(loopResult(cleanAuditText));
await runSecurityAudit(testContract, testEvaluation, "/tmp/project", config);
const userMessage = loopSpy.mock.calls[0][0].userMessage as string;
expect(userMessage).toContain(<a retrieved signature id/title>);
```
The auditor test uses the **REAL** stack resolver (no mock) — so once you re-wire the auditor to the new resolver+index, this test exercises the real repo `skills/bober.security-*/` files. Keep it that way (the header comment at `security-auditor-agent.test.ts:6-9` explains why).

### E2E Test Pattern
Not applicable — no Playwright in this path.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|---|---|---|---|
| `security-auditor-agent.ts` | `resolveStackSecurityContext` (being replaced) | **high** | Import path + call site (line 14, 79) must switch to `./security-knowledge/resolver.js`; keep `ALL_VULN_CLASSES` from `stack-knowledge.js`. |
| `stack-knowledge.test.ts` | old `resolveStackSecurityContext` (head-excerpt) | **high** | ALL 9 tests assert head-excerpt behavior — see below. |
| `parser.ts`, `parser.test.ts`, `security-scanners.ts`, `security-audit-types.test.ts`, `skill-files.test.ts` | `ALL_VULN_CLASSES` from `stack-knowledge.js` | **low** | Only break if you MOVE `ALL_VULN_CLASSES`. Keep it exported from `stack-knowledge.ts`. |

### Existing Tests That Must Still Pass (and the exact assertions to update)

**`security-auditor-agent.test.ts` — 4 assertions in the sc-2-3 block break (renamed to reflect new behavior):**
- `:294` `expect(userMessage).toContain("Security Checklist")` → BREAKS. New fragment renders signatures, not the `## Security Checklist` heading. Update to a real signature token, e.g. `expect(userMessage).toContain("solidity.reentrancy-single-function")` (or `"reentrancy"`).
- `:296` `expect(userMessage).toContain("Skill: bober.solidity")` → BREAKS. New skillName is `bober.security-solidity`. Update to `"Skill: bober.security-solidity"`.
- `:306` `expect(userMessage).toContain("Skill: none (generic taxonomy only)")` → BREAKS if generic floor now carries a real skill name (sc-5-1 says unknown→generic resolves to a REAL skill name `bober.security-generic`). Update to `"Skill: bober.security-generic"`.
- `:307-309` `expect(userMessage).toContain("Focus on injection vulnerabilities, authentication and authorisation gaps")` → BREAKS if the resolver no longer injects `resolveLensFocus("security")` text. Update to a generic signature token, e.g. `expect(userMessage).toContain("sql-injection")`.
- `:295` `expect(userMessage).toContain("Stack: solidity")` → STAYS (stackLabel unchanged).
- ALL other tests in this file (fail-closed parse `:186-230`, parseSecurityAuditResult `:234-281`, standalone/error `:337-373`, client wiring `:375-420`, nonGoal toolset `:422-454`, scanner wiring `:456-517`) DO NOT touch the resolver output → keep green untouched.

**`stack-knowledge.test.ts` — the decision point (see §8 step 5):**
All 9 tests import `resolveStackSecurityContext` from `./stack-knowledge.js` and assert head-excerpt behavior (`:57` "Security Checklist", `:60` "irrelevant trailer content" absence, `:89` head-excerpt "Anchor Skill", `:110` `promptFragment === genericFragment`). If you REMOVE the old resolver from `stack-knowledge.ts` (recommended — closes the G3 code path), this file will fail to import → **DELETE it** (its resolver coverage is superseded by `resolver.test.ts`; its `ALL_VULN_CLASSES`/taxonomy coverage is already held by `security-audit-types.test.ts:127`). If you instead KEEP the old resolver as dead-but-exported code (zero test churn), leave this file green — but that leaves the G3 defect code path in the tree (quality/simplicity-lens risk). **Recommend: remove old resolver + delete this test file, in the same commit.**

### Features That Could Be Affected
- **Scanner pre-filter (sprint-5 seam)** — shares `security-auditor-agent.ts` but is orthogonal (`:86-104`); verify `scanners:[]` still spawns zero processes (test `:459-469`) and priors still render (`:471-497`).
- **The gate / `bober security-audit` CLI** — consumes `runSecurityAudit`'s unchanged public result; verify `SecurityAuditResult.stack` still equals the stack label (test `:179`).

### Recommended Regression Checks (runnable)
1. `npx vitest run src/orchestrator/security-auditor-agent.test.ts` — the 4 sc-2-3 assertions updated, everything else green.
2. `npx vitest run src/orchestrator/security-knowledge/` — new registry/index/selector/resolver tests + existing parser/signature/skill-files tests all pass.
3. `npx vitest run src/orchestrator/security-audit-types.test.ts` — `ALL_VULN_CLASSES` lockstep intact.
4. `npm run build && npx tsc --noEmit && npm run lint` (sc-5-6).
5. Full suite `npm test` green.
6. Config-omitting-security byte-identical: a `createDefaultConfig` without a `security` section must parse deep-equal (evaluatorNotes sc-5-6) — the resolver change is inside `runSecurityAudit`, gated by the audit path, so config parsing is untouched; confirm no schema edits crept in.

---

## 8. Implementation Sequence (dependency-ordered)

1. **registry.ts** — `SecurityStackId` map (8 stacks + generic floor), precedence ported from `detectStack` (`stack-knowledge.ts:86-108`), `unknown → "generic"`. Export the stackId→skillName entries for the index to iterate.
   - Verify: a table-test resolve() over all 7 keywords + an unknown → `generic` (sc-5-1); every entry's `skillName` is `bober.security-<stack>`.
2. **index.ts** — `SecurityKnowledgeIndex` with `load()` (memoise, iterate registry entries, `parser.parse`, missing file → `[]`, never throw), `forStack`, `all`, `skillsRoot` ctor option. Mind the THREE `..` to the skills root from this deeper dir.
   - Verify: real-file test asserts each of 8 stacks indexes ≥6 (sc-5-2); missing skillsRoot → all `[]`, no throw.
3. **selector.ts** — pure `selectSignatures`: score = stack-match + keyword overlap + path hints, cap `topK` (default 8), ALWAYS concat + dedup generic floor.
   - Verify: a diffKeyword matching a signature's `keywords` ranks it in; topK respected; every generic-floor signature present (sc-5-3).
4. **resolver.ts** — new `StackSecurityContext` (adds `stackId`, `signatures`) + `resolveStackSecurityContext(input)` rendering signatures into a never-empty `promptFragment` (+ optional `threatModelText`; fallback to `resolveLensFocus("security")` only if the floor is somehow empty).
   - Verify: `resolver.test.ts` — fragment non-empty for all 8, contains a stack-appropriate token, no frontmatter leakage (sc-5-4, G3 closed).
5. **stack-knowledge.ts cleanup** — remove `resolveStackSecurityContext`, `detectStack`, `extractSecurityExcerpt`, `readSkillSecurityExcerpt`, `STACK_SKILL_MAP`, old `StackSecurityContext`, `SecuritySkillName`, and now-unused imports (`readFile`, `join`, `dirname`, `fileURLToPath`, `resolveLensFocus`, `Stack`). **KEEP `ALL_VULN_CLASSES` (and any `VulnClass` re-export).** Then DELETE `stack-knowledge.test.ts`.
   - Verify: `grep -rn "from .*stack-knowledge" src` shows only `ALL_VULN_CLASSES` importers remain; `tsc --noEmit` clean (no unused-import lint error).
6. **security-auditor-agent.ts** — switch the import (line 14: keep `ALL_VULN_CLASSES` from stack-knowledge, add resolver+index from security-knowledge), build `index` + `load()` once, replace the line-79 call with the input object (`changedPaths: contract.estimatedFiles`). Leave `buildUserMessage` and the fail-closed parser untouched.
   - Verify: sc-5-5 stub-loop test shows a retrieved signature id/title in the userMessage.
7. **security-auditor-agent.test.ts** — update the 4 sc-2-3 assertions (see §7). Leave all other tests untouched.
   - Verify: whole file green.
8. **Run full verification** — `npm run build`, `npx tsc --noEmit`, `npm run lint`, `npm test` (sc-5-6).

---

## 9. Pitfalls & Warnings

- **Skill name namespace:** new skills are `bober.security-<stack>`, NOT the old `bober.<stack>`. The old `STACK_SKILL_MAP` (`stack-knowledge.ts:62-66`) and the old `SecuritySkillName` union (`stack-knowledge.ts:12`) point at the OLD names — do not copy them; the registry uses the new `bober.security-*` names (all 8 dirs verified present).
- **`ALL_VULN_CLASSES` is a shared hub — do NOT move it.** 6 files import it from `stack-knowledge.js` (parser.ts, security-scanners.ts, security-auditor-agent.ts, security-audit-types.test.ts, parser.test.ts, skill-files.test.ts). Moving it cascades 6 breakages. Keep the export in place.
- **Deleting the old resolver ⇒ delete `stack-knowledge.test.ts` in the SAME commit.** Its 9 tests import `resolveStackSecurityContext` from `./stack-knowledge.js`; a missing export is a compile error, not a test failure — the whole suite won't build. This is the #1 regression trap.
- **Do NOT `readdir` the skills directory** to discover stacks — that sweeps in `skills/bober.security-audit/` (the orchestration skill, 4 blocks, not a stack) and the parser needs a known `stackId` per file. Iterate the registry's 8 entries.
- **Directory depth:** `security-knowledge/index.ts` is one level deeper than `stack-knowledge.ts`. Default skills root = three `..` (`join(dir, "..","..","..","skills")`), not two. A wrong depth makes every `forStack` return `[]` silently (never throws) — catch it with the real-file ≥6 test.
- **`index.ts` is not a barrel.** Import it as `./security-knowledge/index.js` for the class; do not turn it into a re-export barrel (name is dictated by estimatedFiles).
- **Fail-closed parse + read-only toolset are untouched invariants.** Do not add `bash`/`write_file`/`edit_file` to the auditor (curator role, `tools/index.ts:64` = `["read_file","glob","grep"]`); do not soften `parseSecurityAuditResult` (`:270-345`) or `deriveVerdict` (`:146`). Regression tests at `security-auditor-agent.test.ts:422-454` enforce the toolset; keep them green.
- **anchor's ≥6 margin is tight (7 blocks).** Don't let a parser/index change silently drop below 6 for anchor — the sc-5-2 real-file test guards this.
- **Config-omitting-security byte-identical (sc-5-6):** keep all changes inside `runSecurityAudit`/`security-knowledge/`; no edits to `config/schema.ts` (StackSchema at `:8-16` is read-only for this sprint).
