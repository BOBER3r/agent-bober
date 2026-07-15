# Sprint Briefing: Dogfood enablement + docs + update-all sync

**Contract:** sprint-spec-20260714-security-auditor-per-stack-skills-10
**Generated:** 2026-07-14T00:00:00Z
**Sprint type:** config + docs + sync + one new offline smoke test. NO runtime component behavior changes (nonGoals[3]).

---

## 0. TL;DR for the Generator

This sprint has FIVE deliverables. The single highest-risk item is #1's ripple:

1. **`bober.config.json`** — add `project.stack` + four security sub-objects.
2. **`src/config/schema.test.ts:877-963`** — the dogfood snapshot `toEqual` MUST be updated in lockstep or it fails. THIS IS NOT IN `estimatedFiles` BUT IS MANDATORY. (See §7.)
3. **`docs/security-audit.md`** — consolidate/add sections (most concepts already present; do NOT duplicate).
4. **`skills/bober.security-audit/SKILL.md` + `agents/bober-security-auditor.md`** — additive references to per-stack skills / verifier / supply-chain.
5. **Sync** into this repo's own `.claude/` + a new offline smoke test `src/orchestrator/security-knowledge/dogfood-smoke.test.ts`.

The #1 way this sprint fails: editing `bober.config.json` and NOT updating the snapshot in `schema.test.ts` → `npm test` red. There is exactly ONE such test (verified by grep, see §7).

---

## 1. Target Files

### bober.config.json (modify)

**Current full content** (`/Users/bober4ik/agent-bober-workspace/agent-bober/bober.config.json`, lines 1-4 and 75-79 are what change):
```json
  "project": {
    "name": "agent-bober",
    "mode": "greenfield"
  },
  ...
  "security": {
    "enabled": true,
    "scanners": []
  },
```

**Exact edit to make** — `project` gains a `stack`, `security` gains four sub-objects:
```json
  "project": {
    "name": "agent-bober",
    "mode": "greenfield",
    "stack": { "language": "typescript", "backend": "node" }
  },
  ...
  "security": {
    "enabled": true,
    "scanners": [],
    "diff": { "mode": "git-diff" },
    "supplyChain": { "enabled": true },
    "egress": { "onlineResearch": false },
    "verifier": { "enabled": true }
  },
```

**Why `{ "language": "typescript", "backend": "node" }` resolves to `node`:** `SecurityStackRegistry.resolve` (`src/orchestrator/security-knowledge/registry.ts:120-142`) builds candidates in order `[blockchain, language, frontend, backend, testing, database, ...other]` (`registry.ts:86-94`) and substring-matches each against `STACK_KEYWORDS`. `"typescript"` matches `{ pattern: "typescript", stackId: "node" }` (`registry.ts:59`); `"node"` matches `{ pattern: "node", stackId: "node" }` (`registry.ts:57`). Either key alone resolves to `node` — providing both is belt-and-suspenders and unambiguous. `language` is checked before `backend`, so `typescript` wins first; both point at `node` so the label will be `"typescript"`.

> NOTE: keep the JSON minimal. Do NOT add `baseRef`, `expandWithGraph`, `scanners`, `model`, or `maxTurns` — the schema defaults fill those in (see §7 for the exact materialized shape you must mirror in the snapshot).

---

### src/config/schema.test.ts (modify — NOT in estimatedFiles, MANDATORY, see §7)

The dogfood-config snapshot at lines **877-963** reads the REAL `bober.config.json` and does a full `expect(parsed).toEqual({...})`. Adding `project.stack` + the four security sub-objects changes the parsed output, so the expected object at lines **890-962** must be updated in the same commit.

---

### docs/security-audit.md (modify)

**Existing headings** (`grep -n '^#'`):
```
1   # Security Audit
19  ## Quick Start          (### CLI / ### Skill)
72  ## Pipeline Gate
128 ## Finder → verifier stage
173 ## Configuration Reference
303 ## Scanners
364 ## Hub Emission
402 ## Fail-Closed Guarantees
427 ## Roadmap: per-stack signature libraries (in progress)
509 ## FAQ
```
**Concept coverage today** (case-insensitive line hit counts): `per-stack` 7, `supply-chain` 15, `supplyChain` 9, `verifier` 36, `egress` 10, `signature` 22, `structured metadata/finding` 2, `taxonomy` 2, `"17"` **0**, `threatModel` **0**.

**What sc-10-2 still needs (CONSOLIDATE, don't duplicate — the verifier/supply-chain/egress prose already exists):**
- Retitle/finalize the "Roadmap: per-stack signature libraries (in progress)" section (`docs/security-audit.md:427`) — it is now SHIPPED, not roadmap. Describe the 8-stack registry (`skills/bober.security-<stack>/SKILL.md`) and **how to add/edit a signature** (the SKILL.md signature format the parser reads — see `src/orchestrator/security-knowledge/parser.ts` and any `skills/bober.security-node/SKILL.md` for the block shape).
- The widened **17-class taxonomy** ("17" has 0 hits — add it) + **structured finding metadata** (`vulnClass`/`cwe`/`signatureId` — only 2 hits, thin).
- Ensure the **Configuration Reference** section (`docs/security-audit.md:173`) lists `verifier` / `supplyChain` / `diff` / `egress`.

**PITFALL — `threatModelPath` does NOT exist.** sc-10-2 lists "threatModelPath" as a config key, but grep confirms it is NOT in `src/config/schema.ts` and NOT anywhere in the codebase. The real thing is `threatModelText?: string` — an in-memory INPUT field on `ResolveStackSecurityContextInput` (`src/orchestrator/security-knowledge/resolver.ts:78-79`), not a config key. Document `threatModelText` as the resolver's optional threat-model injection input; do NOT invent a `threatModelPath` config key (the config schema would reject it as an unknown key only if strict — it is a plain `z.object` so extra keys are stripped, but writing it in `bober.config.json` would be silently dropped and misleading). If you mention it in the config table, label it accurately as the resolver input, not a `security.*` config field.

---

### skills/bober.security-audit/SKILL.md (modify)

254 lines. **Zero** mentions of `per-stack` / `verifier` / `supply-chain` / `security-node` (`grep -nic` = 0). sc-10-3 needs ADDITIVE paragraphs: reference the 8 per-stack skills (`bober.security-<stack>`), the finder→verifier stage, and the supply-chain axis. Frontmatter head shown in §2.

---

### agents/bober-security-auditor.md (modify)

Frontmatter + head (`agents/bober-security-auditor.md:1-18`):
```markdown
---
name: bober-security-auditor
description: Stack-aware security auditor that audits a sprint diff for exploitable vulnerabilities, organises findings by VulnClass with path+line+snippet evidence, and emits a ReviewResult — never writes, edits, or blocks completion itself (the gate does that).
tools:
  - Read
  - Grep
  - Glob
model: opus
---
```
sc-10-3: add that the auditor now receives (a) RETRIEVED per-stack signatures (not a head-excerpt), (b) a REAL diff, and describe the widened 17-class taxonomy + structured finding fields (`vulnClass`/`cwe`/`signatureId`). Keep additive.

---

### src/orchestrator/security-knowledge/dogfood-smoke.test.ts (create)

Does NOT exist. This is the sc-10-5 offline constructability smoke. Template in §6.

---

## 2. Patterns to Follow

### Pattern: the four security sub-schemas are all `.optional()` with NO outer default
**Source:** `src/config/schema.ts:246-296`
```ts
export const SecuritySectionSchema = z.object({
  enabled: z.boolean().default(false),
  ...
  diff: SecurityDiffConfigSchema.optional(),          // 269
  supplyChain: SecuritySupplyChainConfigSchema.optional(), // 275
  egress: SecurityEgressConfigSchema.optional(),      // 280
  verifier: z.object({                                 // 289-295
    enabled: z.boolean().default(false),
    model: ModelChoiceSchema.default("opus"),
    maxTurns: z.number().int().min(1).default(10),
  }).optional(),
});
```
**Rule:** Because each is `.optional()` with no default, OMITTING it in JSON = key absent from parse output. PROVIDING it (even `{}`) materializes its INNER defaults. This is exactly why the snapshot must be updated once you add them.

### Pattern: skills/agents sync is verbatim-agents + inlined-commands (NOT a `.claude/skills/` dir)
**Source:** `scripts/update-all.mjs:113-149`
```js
// Commands (inlined skills) — skills/bober.X/SKILL.md -> .claude/commands/bober-X.md
for (const [skillDir, commandFile] of Object.entries(skillMap)) { ... }
// Agents (verbatim) — agents/*.md -> .claude/agents/*.md
for (const agentFile of agentFiles) { ... }
```
**Rule:** There is NO `.claude/skills/` directory (`ls -d .claude/skills` → does not exist). Per-stack skills land as `.claude/commands/bober-security-<stack>.md`; the new agent lands as `.claude/agents/bober-security-verifier.md`. sc-10-4's phrase "the .claude skills copy" MEANS `.claude/commands/bober-security-*.md`.

### Pattern: real-file index/resolver construction in tests
**Source:** `src/orchestrator/security-knowledge/resolver.test.ts:9-16`
```ts
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REPO_SKILLS_ROOT = join(REPO_ROOT, "skills");
let index: SecurityKnowledgeIndex;
beforeAll(async () => { index = new SecurityKnowledgeIndex(REPO_SKILLS_ROOT); await index.load(); });
```
**Rule:** `SecurityKnowledgeIndex`'s default skills root already resolves to the repo `skills/` (`index.ts:20-23`), so `new SecurityKnowledgeIndex()` with NO arg also works from a test under `src/orchestrator/security-knowledge/`. The smoke test can use either.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `SecurityStackRegistry.resolve` | `src/orchestrator/security-knowledge/registry.ts:121` | `(stack: Stack \| string \| undefined) => StackResolution` | Resolves `project.stack` → `{stackId, stackLabel, skillName}`; `node` for this repo. Never throws. |
| `SecurityKnowledgeIndex` | `src/orchestrator/security-knowledge/index.ts:35` | `new (skillsRoot?)`; `.load(): Promise<void>`; `.forStack(id)`; `.all()` | Memoised per-stack parsed signatures. Default root = repo `skills/`. |
| `resolveStackSecurityContext` | `src/orchestrator/security-knowledge/resolver.ts:91` | `(input: ResolveStackSecurityContextInput) => Promise<StackSecurityContext>` | Retrieval-grounded prompt context; `promptFragment` never empty. Input needs `{stack, changedPaths, index}`. |
| `runSecurityVerifier` | `src/orchestrator/security-verifier-agent.ts:59` | `SecurityVerifier` = `{ verify(params: VerifyParams): Promise<VerifierResult> }` | Adversarial verifier. `findings:[]` short-circuits to `{verified:[],downgraded:[],dropped:[],ran:true}` with NO LLM call (`verifier:60-68`) — the offline smoke seam. |
| `BoberConfigSchema` | `src/config/schema.ts` (parse) | `.parse(raw) => BoberConfig` | Parses config; materializes defaults. |
| `createDefaultConfig` | `src/config/schema.ts` (exported; used in tests) | `(name, mode) => BoberConfig` | Test-config factory (does NOT set `security`). |
| `SecuritySection` type | `src/config/schema.ts:297` | `z.infer<typeof SecuritySectionSchema>` | Type for the fixture in the verifier test (§6). |
| `buildSkillMap` (update-all) | `scripts/update-all.mjs:42-55` | derives `bober.X` → `bober-X.md` | Sync mechanism; the reason per-stack skills auto-appear in `.claude/commands/`. |

**Utilities reviewed:** `src/orchestrator/security-knowledge/` (registry, index, resolver, selector, parser, diff-provider, supply-chain-inspector), `src/config/schema.ts`, `scripts/update-all.mjs`. No new utility needed — this sprint writes ZERO new runtime code (only config + docs + one test).

---

## 4. Prior Sprint Output

- **Sprint 5** — `registry.ts` + `index.ts` + `resolver.ts` + `selector.ts` (retrieval pipeline). This sprint consumes `SecurityStackRegistry.resolve` and `resolveStackSecurityContext` in the smoke test.
- **Sprint 6** — `diff-provider.ts` + `security.diff` config (`config.security.diff.mode: "git-diff"`). This sprint SETS `diff.mode: "git-diff"` in `bober.config.json`.
- **Sprint 7** — `supply-chain-inspector.ts` + `security.supplyChain` + `security.egress`. This sprint SETS `supplyChain.enabled: true` + `egress.onlineResearch: false`.
- **Sprint 8** — `src/orchestrator/security-verifier-agent.ts` (`runSecurityVerifier`) + `agents/bober-security-verifier.md` + `security.verifier` config. This sprint SETS `verifier.enabled: true`, references the agent in docs/skill, and SYNCS the agent file into `.claude/agents/`.
- **Sprint 9** — benchmark harness (`security-knowledge/benchmark/`). Not directly touched.

**Verified present:** all 8 `skills/bober.security-*/SKILL.md` dirs exist (`solidity, anchor, react, node, payments, igaming, dex-backend, generic` + the orchestration skill `bober.security-audit`); `agents/bober-security-verifier.md` AND `agents/bober-security-auditor.md` both exist in `agents/`.

---

## 5. Relevant Documentation

**Project Principles:** No `.bober/principles.md` read for this sprint; the governing constraint is the schema's fail-safe-opt-in convention (every egress/verifier/diff flag defaults OFF — `schema.ts:200-296`). nonGoals[1] reinforces: egress stays OFF (`egress.onlineResearch: false`).

**Architecture:** `arch-20260712-security-audit-agent-team-architecture.md` (referenced from `registry.ts:6`) defines the 8-stack model + generic floor (ADR-5 orchestrator-owns-diff, ADR-7 per-process memoised index). No new ADR needed.

**Distribution (from memory `agent-bober-distribution`):** CLI shared via npm symlink (`npm run build` recompiles); skills/agents COPIED per project into `.claude/` by `update-all`. See §7 sc-10-4 for the exact command.

---

## 6. Testing Patterns

### Unit test pattern (the smoke test to create)
**Runner:** vitest. **Assertion:** `expect(...).toBe/.toEqual`. **Location:** co-located (`*.test.ts` next to source). **No live LLM in CI** — inject/short-circuit.

**Config-read pattern** (`src/config/schema.test.ts:878-881`):
```ts
const raw = await readFile(join(process.cwd(), "bober.config.json"), "utf-8");
const parsed = BoberConfigSchema.parse(JSON.parse(raw));
```

**Real-index + resolver pattern** (`resolver.test.ts:9-16` + `index.test.ts:29-31`):
```ts
const index = new SecurityKnowledgeIndex();      // default root = repo skills/
await index.load();
const ctx = await resolveStackSecurityContext({ stack: parsed.project.stack, changedPaths: ["src/x.ts"], index });
expect(ctx.stackId).toBe("node");
expect(ctx.promptFragment.length).toBeGreaterThan(0);
```

**Verifier OFFLINE seam** — `runSecurityVerifier.verify` with `findings: []` returns `ran:true` WITHOUT any provider call (`security-verifier-agent.ts:66-68`). This is the no-live-LLM constructability proof:
```ts
const result = await runSecurityVerifier.verify({
  findings: [], diff: undefined, projectRoot: process.cwd(),
  config: parsed, signal: new AbortController().signal,
});
expect(result.ran).toBe(true);   // wiring constructable, no LLM needed
```

**Recommended smoke test (`dogfood-smoke.test.ts`) — assertions:**
1. Parse real `bober.config.json`; assert `security.verifier.enabled === true`, `security.supplyChain.enabled === true`, `security.diff.mode === "git-diff"`, `security.egress.onlineResearch === false` (nonGoal guard).
2. `SecurityStackRegistry.resolve(parsed.project.stack).stackId === "node"`.
3. Build `SecurityKnowledgeIndex`, `load()`, `resolveStackSecurityContext({stack: parsed.project.stack, changedPaths, index})` → `stackId === "node"`, non-empty `promptFragment`.
4. `runSecurityVerifier.verify({findings: [], ...})` → `ran: true` (offline).

> If you also want the "build-dist child-process smoke" (medical-import sax lesson): after `npm run build`, `execFileSync(process.execPath, ["-e", "import('./dist/...').then(...)"])` — OPTIONAL. The src-level unit smoke above already satisfies sc-10-5 "constructable offline". Prefer the unit smoke; add the child-process variant only if cheap.

**Verifier-test mock convention (if you DO need to stub the loop instead of the findings:[] seam):** `src/orchestrator/security-verifier-agent.test.ts:20-38` — `vi.mock("./agentic-loop.js", ...)`, `vi.mock("../providers/factory.js", ...)`, `vi.mock("./tools/index.js", ... getGraphState: () => ({graphEnabled:false, engineHealth:"disabled"}))`. The `fullSecurityDefaults` fixture (`security-verifier-agent.test.ts:43-53`) shows the exact `SecuritySection` shape.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### THE break: the dogfood snapshot test (CRITICAL — update in lockstep)
**File:** `src/config/schema.test.ts:877-963`. It is the ONLY test that reads the repo's real `bober.config.json` via `process.cwd()` and asserts its full shape (verified: `grep -rln 'process.cwd()' src --include='*.test.ts' | xargs grep -l 'bober.config.json'` → ONLY `schema.test.ts`; and the one line is `schema.test.ts:879`).

Current expected object asserts (lines 890-962):
```ts
project: { name: "agent-bober", mode: "greenfield" },          // line 891 — MUST gain stack
...
security: {                                                     // lines 951-960 — MUST gain 4 sub-objects
  enabled: true, failClosed: true, timeoutMs: 300_000,
  model: "opus", maxTurns: 20, scanners: [],
  standaloneBlockOn: "critical", hub: true,
},
```

**Update lines 891 and 951-960 to EXACTLY** (deep-equal, key order irrelevant; values below are the schema-materialized defaults you must include):
```ts
project: { name: "agent-bober", mode: "greenfield", stack: { language: "typescript", backend: "node" } },
...
security: {
  enabled: true, failClosed: true, timeoutMs: 300_000,
  model: "opus", maxTurns: 20, scanners: [],
  standaloneBlockOn: "critical", hub: true,
  diff: { mode: "git-diff", expandWithGraph: false },   // baseRef is optional-no-default => ABSENT
  supplyChain: { enabled: true, scanners: [] },
  egress: { onlineResearch: false },
  verifier: { enabled: true, model: "opus", maxTurns: 10 },
},
```
Materialization rules that produced the above:
- `SecurityDiffConfigSchema` (`schema.ts:216-220`): `mode` provided; `expandWithGraph` default `false`; `baseRef` optional-no-default → NOT present.
- `SecuritySupplyChainConfigSchema` (`schema.ts:229-232`): `enabled` provided; `scanners` default `[]`.
- `SecurityEgressConfigSchema` (`schema.ts:241-243`): `onlineResearch` provided `false`.
- `verifier` inline (`schema.ts:289-295`): `enabled` provided; `model` default `"opus"`; `maxTurns` default `10`.
- `StackSchema` (`schema.ts:8-16`): all fields optional, NO defaults → only the two keys you write appear.

### Files that read the real config but do NOT break
| File | Why safe |
|------|----------|
| `src/config/loader.test.ts` | Writes its OWN config to a tmp dir (`loader.test.ts:51,72,89,103`); never reads repo config. |
| `src/cli/commands/security-audit.test.ts` | Uses fixture `stack: "node"` + `SecurityDefaults` mocks (`:82,:135`); does not read/assert repo config. |
| `list-projects / get-project-state / run / memory / update / config / blackboard / scaffolder .test.ts` | All grep-matched `bober.config.json` because they WRITE tmp configs; none assert the repo's real security/stack shape (only `schema.test.ts` uses `process.cwd()`). |

### Existing tests that must still pass (touch the same modules but should be unaffected)
- `src/orchestrator/security-knowledge/registry.test.ts` — `SecurityStackRegistry.resolve` behavior; unchanged (no code edit).
- `src/orchestrator/security-knowledge/resolver.test.ts` / `index.test.ts` — real-skill resolution; unchanged.
- `src/orchestrator/security-verifier-agent.test.ts` — verifier stage; unchanged.
- `src/orchestrator/security-knowledge/skill-files.test.ts` — asserts the 8 skill files exist/parse; adding text to `bober.security-audit/SKILL.md` does NOT add a stack file, safe. If it asserts signature COUNTS per stack (`index.test.ts` asserts `>= 6`), do NOT remove signatures from any `bober.security-<stack>` file.

### sc-10-4 sync — WHERE plain `npm run update-all` will NOT help
`scripts/sync-targets.json` `targets` = ONLY the four solex demo paths; **this repo (`/Users/bober4ik/agent-bober-workspace/agent-bober`) is NOT a registered target.** So `npm run update-all` (no args) will NOT touch this repo's own `.claude/`. To sync into THIS repo you MUST pass its path explicitly (path-arg mode ignores the registry — `update-all.mjs:214-218`):
```
node scripts/update-all.mjs --skills-only /Users/bober4ik/agent-bober-workspace/agent-bober
```
(`--skills-only` skips the `npm run build` that plain update-all runs first — safer/faster in a sprint sandbox; drop it if you want the build too.) This will:
- copy `agents/bober-security-verifier.md` verbatim → `.claude/agents/bober-security-verifier.md` (currently ABSENT — verified: `.claude/agents/` has `bober-security-auditor.md` but not `-verifier.md`).
- inline `skills/bober.security-<stack>/SKILL.md` → `.claude/commands/bober-security-<stack>.md` (currently only `.claude/commands/bober-security-audit.md` exists; the 8 per-stack command files are ABSENT).

**Test/check for sc-10-4** (write it to be robust whether or not sync ran):
- ASSERT source files present: `agents/bober-security-verifier.md`, `skills/bober.security-node/SKILL.md`, `skills/bober.security-generic/SKILL.md` (these are the "ready to sync" guarantee).
- IF sync ran, ALSO assert `.claude/agents/bober-security-verifier.md` + `.claude/commands/bober-security-generic.md` + `.claude/commands/bober-security-node.md` exist. If it cannot run in-sandbox, the test documents the exact command above and asserts only the source files (contract assumption[1] + sc-10-4 explicitly allow "documents the exact sync command if update-all is not runnable").

### Recommended regression checks (Generator MUST run)
1. `npm test` (full suite) — specifically that `schema.test.ts` dogfood snapshot passes AFTER updating it.
2. `npm run build` (sc-10-5 requires build success).
3. `npm run typecheck` and lint clean (evaluatorNotes).
4. Confirm `egress.onlineResearch` is `false` in both `bober.config.json` AND the updated snapshot (nonGoal[1]).

---

## 8. Implementation Sequence

1. **bober.config.json** — add `project.stack` + the 4 security sub-objects (§1). Minimal JSON only.
   - Verify: `node -e "const c=require('./bober.config.json'); console.log(c.project.stack, c.security.verifier)"`.
2. **src/config/schema.test.ts:891,951-960** — update the dogfood snapshot to the exact materialized shape in §7. DO THIS IMMEDIATELY AFTER STEP 1.
   - Verify: `npx vitest run src/config/schema.test.ts`.
3. **src/orchestrator/security-knowledge/dogfood-smoke.test.ts** (create) — the offline smoke (§6).
   - Verify: `npx vitest run src/orchestrator/security-knowledge/dogfood-smoke.test.ts`.
4. **docs/security-audit.md** — consolidate per-stack registry (retitle the "Roadmap" section as shipped) + how-to-add-a-signature + 17-class taxonomy + structured metadata + config keys (verifier/supplyChain/diff/egress). Do NOT re-document threatModelPath as a config key (§1 pitfall).
5. **skills/bober.security-audit/SKILL.md** + **agents/bober-security-auditor.md** — additive references (per-stack skills, verifier stage, supply-chain axis, structured fields, real diff). Reference `agents/bober-security-verifier.md` in the skill catalog/docs (sc-10-3).
6. **Sync** — run the path-arg update-all command (§7 sc-10-4) into this repo's `.claude/`; if not runnable, ensure the sc-10-4 check asserts source files + documents the command.
7. **Run full verification** — `npm run build`, `npm test`, `npm run typecheck`, lint. Confirm suite green (~4270+ tests).

---

## 9. Pitfalls & Warnings

- **THE snapshot.** `src/config/schema.test.ts:877-963` will go red the instant you edit `bober.config.json` unless you update lines 891 + 951-960 in the same change. It is NOT in `estimatedFiles` — do not skip it. (§7 has the exact replacement.)
- **`threatModelPath` is a phantom.** sc-10-2 names it but it does NOT exist in the schema or codebase. The real construct is the resolver INPUT `threatModelText` (`resolver.ts:78-79`). Do not add a `security.threatModelPath` config key (it would be silently stripped by the plain `z.object` and mislead readers).
- **No `.claude/skills/` directory.** Skills sync as inlined `.claude/commands/bober-security-<stack>.md`, agents as `.claude/agents/*.md`. Assert against `.claude/commands/...`, not `.claude/skills/...`.
- **Plain `npm run update-all` skips THIS repo.** This repo is not in `scripts/sync-targets.json` `targets`. You MUST pass the absolute repo path as an arg (§7). Otherwise the new agent/skills never land in this repo's `.claude/`.
- **`update-all` runs `npm run build` first** (unless `--skills-only`) via `execSync` — in a constrained sandbox that can be slow/fail; prefer `--skills-only` for the sync step, and run `npm run build` separately for sc-10-5.
- **Do not omit `diff.mode`'s materialized `expandWithGraph: false`** from the snapshot — providing `diff:{}` (even just `mode`) materializes `expandWithGraph` default `false`. But `baseRef` is optional-no-default → it must NOT appear.
- **Do not change runtime behavior** (nonGoals[3]). No edits to `registry.ts`/`resolver.ts`/`security-verifier-agent.ts`/schema `*.ts`. Config + docs + one test only.
- **Signature counts.** `index.test.ts` asserts each stack indexes `>= 6` signatures. Editing `skills/bober.security-audit/SKILL.md` (the orchestration skill, NOT a stack) is fine; do NOT trim any `bober.security-<stack>` signature blocks.
