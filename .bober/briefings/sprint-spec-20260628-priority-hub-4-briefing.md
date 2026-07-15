# Sprint Briefing: priority.md renderer and `bober hub priority` / `bober hub decide`

**Contract:** sprint-spec-20260628-priority-hub-4
**Generated:** 2026-06-29T00:00:00Z

---

## 0. TL;DR for the Generator

Build three things, in this order:
1. **`src/hub/priority-md.ts`** — PURE `renderPriorityMd(ranked, scopeLabel, now)` → markdown string (hand-rolled YAML frontmatter + Dataview table + per-finding rationale). NO IO, NO re-ranking.
2. **`src/hub/hub-config.ts`** — `resolveOutVault(projectRoot, config-or-rawread)` → ABSOLUTE path. Default `<parentOfProjectRoot>/kb-hub`; override `config.hub?.outVault`. The priority.md target is `<outVault>/priority.md`.
3. **`src/cli/commands/hub.ts`** — add `priority` (general/filtered) + `decide <expr>` subcommands and a `runHubPriority(...)` DI core that takes an **injected `LLMClient` + resolved `outVault`** so unit tests run offline. Commander actions build the real client via `createClient` exactly like `chat.ts:33-39`.

**Hard rules:** no new runtime deps (frontmatter is hand-rolled — there is NO `yaml`/`js-yaml` in package.json). `import type` for type-only imports. `.js` extensions on all relative imports. Async `node:fs/promises` only. Handlers NEVER throw — set `process.exitCode = 1` and return. Renderer must NOT re-rank (consume judge order verbatim). Do NOT write into any sibling source repo.

---

## 1. Target Files

### src/hub/priority-md.ts (create)

**Directory pattern:** files in `src/hub/` are kebab-case single-purpose modules with a leading box-header comment, then `// ── Section ──` dividers (`finding-source.ts`, `scope.ts`, `judge.ts`). Tests are collocated `*.test.ts`.

**Most similar existing file for the frontmatter idiom:** `src/medical/lab-note.ts:95-109` (`serializeLabFrontmatter`) and `src/vault/frontmatter.ts:145-164` (`serializeFrontmatter`). **Mirror the idiom; do NOT import either module** (lab-note.ts:9-12 explicitly warns against cross-importing the vault frontmatter).

**Hand-rolled frontmatter idiom — `src/medical/lab-note.ts:95-109`:**
```ts
function serializeLabFrontmatter(fm: LabNoteFrontmatter): string {
  const lines: string[] = ["---"];
  lines.push(`marker: ${fm.marker}`);
  lines.push(`value: ${String(fm.value)}`);
  // ... one `key: value` line per scalar ...
  lines.push("---");
  return lines.join("\n") + "\n";
}
```
**Array-aware variant — `src/vault/frontmatter.ts:145-164`** (use this shape if you emit a `scope`/list value):
```ts
const lines: string[] = ["---"];
for (const [key, val] of Object.entries(frontmatter)) {
  if (Array.isArray(val)) {
    lines.push(`${key}:`);
    for (const item of val as unknown[]) lines.push(`  - ${String(item)}`);
  } else {
    lines.push(`${key}: ${String(val)}`);
  }
}
lines.push("---");
return lines.join("\n") + "\n" + body;
```

**Required signature & output (from generatorNotes + sc-4-1):**
```ts
export function renderPriorityMd(ranked: Finding[], scopeLabel: string, now: Date): string
```
- Frontmatter keys: `generatedAt` (use `now.toISOString()` — the clock is INJECTED, never `Date.now()`), `scope` (= `scopeLabel`), `count` (= `ranked.length`).
- Markdown table with header `| rank | title | domain | kind | urgency | severity | dueBy |` and **exactly one row per finding** (`rank` = 1-based index from array order — DO NOT re-sort). `dueBy` cell: emit the ISO string or empty when `finding.dueBy === undefined`.
- A per-finding rationale/evidence section below the table for Dataview readers (e.g. `### <rank>. <title>` + evidence list). Keep PURE.
- Escape/strip the `|` pipe character from any cell text (titles can contain it) to keep the table valid.

**Imports this file will use:**
- `import type { Finding } from "./finding.js";`

**Test file:** `src/hub/priority-md.test.ts` (create) — snapshot/assert frontmatter keys + one row per finding with all 7 columns (evaluatorNotes).

---

### src/hub/hub-config.ts (create)

**Most similar existing logic:** the raw-JSON config read in `src/cli/commands/hub.ts:59-73` (`resolveConfiguredRepos`) — it reads `bober.config.json` / `.bober/config.json` raw because `config/schema.ts` strips unknown keys (`hub` is NOT a typed field; principles: schema.ts not edited here). The sibling-discovery default uses `dirname(projectRoot)` exactly as `repo-resolver.ts:36-46`.

**Structure template:**
```ts
import { dirname, join, resolve } from "node:path";
import { readJson } from "../utils/fs.js";

const CONFIG_CANDIDATES = ["bober.config.json", ".bober/config.json"] as const;

/** Resolve the kb-hub output vault to an ABSOLUTE path.
 *  config.hub.outVault if present (resolved against projectRoot), else
 *  <parentOfProjectRoot>/kb-hub. Never throws. */
export async function resolveOutVault(projectRoot: string): Promise<string> {
  for (const candidate of CONFIG_CANDIDATES) {
    try {
      const raw = await readJson<{ hub?: { outVault?: unknown } }>(join(projectRoot, candidate));
      const ov = raw.hub?.outVault;
      if (typeof ov === "string" && ov.length > 0) return resolve(projectRoot, ov);
      break; // config existed but no outVault → fall to default
    } catch { /* not found / invalid JSON → try next candidate */ }
  }
  return join(dirname(projectRoot), "kb-hub");
}

/** Target priority.md path inside the resolved out vault. */
export function priorityMdPath(outVault: string): string {
  return join(outVault, "priority.md");
}
```
> Note: `dirname(projectRoot)` is already absolute because `findProjectRoot` returns a `resolve()`d path (`utils/fs.ts:61`); `join` keeps it absolute. Keep the helper for testability (a unit test can pass a temp `projectRoot`).

---

### src/cli/commands/hub.ts (modify)

**Current state (full file is 139 lines). Relevant existing sections:**

Imports (hub.ts:8-20) already pull `findProjectRoot`, `readJson`, `loadConfig`, `FactStore/factsDbPath/ensureFactsDir`, `FactStoreFindingSource/HUB_SCOPE`, `resolveSiblingRepos`, `collectFindings`. **You must ADD:** `createClient` (factory.js), `resolveRoleProviders` (config/role-providers.js), `parseScope`/`Scope`/`applyFilter` as needed (scope.js), `rankFindings` (judge.js), `renderPriorityMd` (priority-md.js), `resolveOutVault`/`priorityMdPath` (hub-config.js), `ensureDir`/`fileExists` (utils/fs.js), `writeFile` (node:fs/promises), `type LLMClient` (providers/types.js).

**The DI core already established in this file — `runHubList` (hub.ts:82-93):**
```ts
export function runHubList(source: FindingSource): void {
  const findings = source.read();
  if (findings.length === 0) { process.stdout.write(chalk.gray("No findings found.\n")); return; }
  for (const f of findings) {
    process.stdout.write(`${f.title}  [${f.kind}]  urgency=${f.urgency}  severity=${f.severity}\n`);
  }
}
```

**How the `list` action is wired (hub.ts:102-138)** — mirror this collect pipeline + try/catch for the new actions:
```ts
hubCmd.command("list").description("...").action(async () => {
  const projectRoot = await resolveRoot();
  try {
    const configuredRepos = await resolveConfiguredRepos(projectRoot);
    const siblings = await resolveSiblingRepos(projectRoot, configuredRepos);
    const sibFindings = collectFindings(siblings, HUB_SCOPE);
    // ... merge own + siblings ...
    runHubList({ read: () => merged });
  } catch (err) {
    process.stderr.write(chalk.red(`Failed to list findings: ${err instanceof Error ? err.message : String(err)}\n`));
    process.exitCode = 1;
  }
});
```

**Where to register the new subcommands:** inside `registerHubCommand` (hub.ts:97-139), after the `list` block, add `hubCmd.command("priority")` and `hubCmd.command("decide <expr>")`.

**Recommended DI core to ADD (export it so the test imports it like `runHubList`):**
```ts
/** DI core for `hub priority` / `hub decide`. Injected llm + resolved outVault keep tests offline.
 *  Ranks (judge order), renders, writes <outVault>/priority.md, prints ranked summary.
 *  Missing outVault dir → clear stderr + process.exitCode=1, NEVER throws. */
export async function runHubPriority(
  findings: Finding[],
  scope: Scope,
  llm: LLMClient,
  outVault: string,
  now: Date,
): Promise<void> {
  if (!(await fileExists(outVault))) {
    process.stderr.write(chalk.red(`kb-hub vault not found at ${outVault} — create it or set hub.outVault in bober.config.json\n`));
    process.exitCode = 1;
    return;
  }
  const ranked = await rankFindings(findings, scope, llm, now);
  const md = renderPriorityMd(ranked, /* scopeLabel */ "...", now);
  const target = priorityMdPath(outVault);
  await ensureDir(dirname(target)); // only the file's own parent — outVault already exists
  await writeFile(target, md, "utf-8");
  ranked.forEach((f, i) => process.stdout.write(`${i + 1}. ${f.title}\n`));
}
```
> `fileExists` (utils/fs.ts:10) does an `access(path, R_OK)` check — use it for the missing-dir gate. Do NOT `ensureDir(outVault)` itself (generatorNotes: "do not auto-create another repo's vault root; only ensure the file's own parent if outVault exists"). Since `priority.md` sits directly in `outVault`, `dirname(target) === outVault` which already exists — the `ensureDir` is a harmless no-op kept for symmetry with `writeLabNote` (lab-note.ts:232).

**The commander action builds the REAL client (mirror chat.ts:33-39) and resolves siblings/scope, then delegates to the core:**
```ts
hubCmd.command("priority")
  .description("Rank findings across siblings and write priority.md")
  .option("--domain <domain>", "filter to one domain")
  .option("--due <days>", "filter to findings due within N days")
  .option("--tag <tag>", "filter to a tag")
  .action(async (opts) => {
    const projectRoot = await resolveRoot();
    try {
      const config = await loadConfig(projectRoot);
      const providers = resolveRoleProviders(config);
      const client = createClient(
        providers.chat, config.chat?.endpoint ?? null,
        config.chat?.providerConfig, config.chat?.model, "chat",
      );
      const configuredRepos = await resolveConfiguredRepos(projectRoot);
      const siblings = await resolveSiblingRepos(projectRoot, configuredRepos);
      const findings = collectFindings(siblings, HUB_SCOPE);
      const scope: Scope = (opts.domain || opts.due || opts.tag)
        ? parseScope({ mode: "filtered", domain: opts.domain, tag: opts.tag,
            dueWithinDays: opts.due !== undefined ? Number(opts.due) : undefined })
        : parseScope({ mode: "general" });
      const outVault = await resolveOutVault(projectRoot);
      await runHubPriority(findings, scope, client, outVault, new Date());
    } catch (err) {
      process.stderr.write(chalk.red(`hub priority failed: ${err instanceof Error ? err.message : String(err)}\n`));
      process.exitCode = 1;
    }
  });
```
For `decide <expr>`: split `expr` on `" vs "` (case-insensitive, trim) into `optionA`/`optionB`, then `parseScope({ mode: "decision", optionA, optionB })`. If the split fails to yield two parts, print a clear usage error + `process.exitCode = 1` and return.

**Imported by:** `src/cli/index.ts` (or the command registry) calls `registerHubCommand`. Adding subcommands is additive — no signature change to `registerHubCommand`, so callers are unaffected.

**Test file:** `src/cli/commands/hub.test.ts` (exists, 131 lines — extend it).

---

## 2. Patterns to Follow

### Real-client construction from config (commander action)
**Source:** `src/cli/commands/chat.ts:30-39`
```ts
const config = await loadConfig(projectRoot);
const providers = resolveRoleProviders(config);
const client = createClient(
  providers.chat,
  config.chat?.endpoint ?? null,
  config.chat?.providerConfig,
  config.chat?.model,
  "chat",
);
```
**Rule:** The commander `.action()` builds the live client this exact way; the `runHubPriority` DI core receives the client as a parameter so tests inject a `ScriptedClient` and never touch the network.

### Handler error discipline — never throw, set exitCode, clear stderr
**Source:** `src/cli/commands/medical.ts:67-99` (the missing-axis / fail-closed branches of `runWhoopSync`)
```ts
if (!egress.isAllowed("device-connection")) {
  process.stderr.write(chalk.red("device-connection egress not enabled — set ...\n"));
  process.exitCode = 1;
  return;
}
```
**Rule:** For the missing-kb-hub-dir case, write a clear `chalk.red(...)` message to stderr, set `process.exitCode = 1`, and `return` — never throw an uncaught stack trace (sc-4-4). Wrap the whole action body in `try/catch` that does the same on any unexpected error (hub.ts:130-137).

### Raw-JSON config read for untyped `hub.*` keys
**Source:** `src/cli/commands/hub.ts:59-73` (`resolveConfiguredRepos`)
```ts
const raw = await readJson<{ hub?: { repos?: unknown } }>(join(projectRoot, candidate));
const repos = raw.hub?.repos;
```
**Rule:** `config/schema.ts` strips unknown keys, and `hub` is NOT a typed field this sprint. Read `hub.outVault` from the raw JSON (mirror this), narrowing `unknown` with `typeof x === "string"`. Do NOT edit `schema.ts`.

### Judge order is final — renderer must not re-sort
**Source:** `src/hub/judge.ts:228-229`
```ts
return [...scored].sort(compareFindings).map((s) => s.finding);
```
**Rule:** `rankFindings` already produced the deterministic order. `renderPriorityMd` assigns `rank = index + 1` over the array as-given. nonGoal: "Do not let the renderer re-rank."

### Immutable findings — never mutate inputs
**Source:** `src/hub/judge.ts:218-223` (copies tags into a new object). **Rule:** the renderer reads only; do not mutate Finding objects or the array.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `createClient` | `src/providers/factory.ts:192` | `(provider?, endpoint?, providerConfig?, model?, role?): LLMClient` | Build the live LLM client in the commander action (mirror chat.ts). |
| `resolveRoleProviders` | `src/config/role-providers.ts:105` | `(config): RoleProviderMap` | Yields `providers.chat` for `createClient`. |
| `loadConfig` | `src/config/loader.ts` | `(projectRoot): Promise<BoberConfig>` | Load+validate config (Zod). |
| `findProjectRoot` | `src/utils/fs.ts:58` | `(startDir?): Promise<string \| null>` | Returns ABSOLUTE root; used by `resolveRoot()` in hub.ts:28-31. |
| `ensureDir` | `src/utils/fs.ts:45` | `(path): Promise<void>` | `mkdir(recursive)` for the file's parent. |
| `fileExists` | `src/utils/fs.ts:10` | `(path): Promise<boolean>` | `access(R_OK)` — use for the missing-kb-hub gate. |
| `readJson` | `src/utils/fs.ts:24` | `<T>(path): Promise<T>` | Raw config read for untyped `hub.outVault`. |
| `writeFile` | `node:fs/promises` | `(path, data, "utf-8")` | Write priority.md (idiom: lab-note.ts:233). |
| `resolveSiblingRepos` | `src/hub/repo-resolver.ts:18` | `(projectRoot, configuredRepos?): Promise<string[]>` | Resolve kb-* / configured sibling repo roots. |
| `collectFindings` | `src/hub/collector.ts:16` | `(repoPaths, scope=HUB_SCOPE): Finding[]` | Pool+dedup findings READ-ONLY from siblings. |
| `rankFindings` | `src/hub/judge.ts:174` | `(findings, scope, llm, now): Promise<Finding[]>` | Two-pass judge; produces final order. |
| `parseScope` | `src/hub/scope.ts:39` | `(raw: unknown): Scope` | Build general/filtered/decision Scope; never throws. |
| `applyFilter` | `src/hub/scope.ts:59` | `(findings, scope, now): Finding[]` | Pure structural filter (called inside rankFindings for filtered). |
| `FactStoreFindingSource` | `src/hub/finding-source.ts:26` | `class(store, scope)` | Read+validate findings from a FactStore (test seeding). |
| `HUB_SCOPE` | `src/hub/finding-source.ts:8` | `"hub"` | FactStore scope constant. |
| `FactStore` / `factsDbPath` / `ensureFactsDir` | `src/state/facts.ts:139 / :77 / :86` | see file | Seed temp sibling stores in tests. |
| `slugify` | `src/medical/lab-note.ts:58` | `(s): string` | URL-safe slug (only if you slugify anything; optional). |
| `serializeFrontmatter` | `src/vault/frontmatter.ts:145` | `(fm, body): string` | **Reference only — DO NOT import.** Mirror the idiom in priority-md.ts. |

**Directories reviewed:** `src/utils/` (fs.ts), `src/hub/` (all modules), `src/config/`, `src/providers/`, `src/state/`, `src/medical/lab-note.ts`, `src/vault/frontmatter.ts`. No existing markdown-table or priority-renderer utility exists — `renderPriorityMd` is genuinely new.

---

## 4. Prior Sprint Output

### Sprint 1 — Finding schema + DI list core
**Created:** `src/hub/finding.ts` — exports `FindingSchema` + `type Finding`. `src/hub/finding-source.ts` — exports `HUB_SCOPE = "hub"`, `interface FindingSource`, `class FactStoreFindingSource`. `src/cli/commands/hub.ts` — exports `runHubList`, `registerHubCommand`.
**Connection:** Import `Finding` from `finding.js` in the renderer; reuse `registerHubCommand`'s `hubCmd` to attach `priority`/`decide`; mirror `runHubList`'s DI-core export style with `runHubPriority`.

### Sprint 2 — collector + sibling resolution
**Created:** `src/hub/collector.ts` — `collectFindings(repoPaths, scope)`. `src/hub/repo-resolver.ts` — `resolveSiblingRepos(projectRoot, configuredRepos?)`. `hub.ts` — `resolveConfiguredRepos` (raw-JSON read).
**Connection:** The priority/decide actions call `resolveConfiguredRepos → resolveSiblingRepos → collectFindings` to build the `Finding[]` pool (identical to the `list` action, hub.ts:114-116).

### Sprint 3 — scope + judge
**Created:** `src/hub/scope.ts` — `type Scope` (general | decision | filtered), `parseScope`, `applyFilter`. `src/hub/lenses.ts`. `src/hub/judge.ts` — `rankFindings(findings, scope, llm, now)`.
**Connection:** The action builds a `Scope` via `parseScope` (filtered from `--domain/--due/--tag`, decision from `"X vs Y"`, else general) and passes it with the injected/real client into `rankFindings`. Its output array order is what the renderer formats.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM + `.js` extensions** on all relative imports; `"type": "module"`. (principles:27)
- **`import type { ... }`** — ESLint `consistent-type-imports` is a hard gate. (principles:35)
- **No synchronous fs** — `node:fs/promises` only (principles:42). No `readFileSync`.
- **No new runtime deps implied** — there is NO `yaml`/`js-yaml` in package.json (verified), so the frontmatter MUST be hand-rolled (principles:33 "small utility modules"; lab-note.ts:9-12 confirms the hand-rolled-subset precedent).
- **Zod for config** — but do NOT add `hub` to `config/schema.ts` this sprint (Sprint 1-2 deliberately read it raw; schema strips unknown keys). (principles:29)
- **Section comments** `// ── Name ──` box headers in long files. (principles:32)
- **No test fs mocks** — tests create temp dirs and clean up. (principles:44)
- **Strict TS** — `noUnusedLocals/Parameters`, `noImplicitReturns`; prefix intentionally-unused params with `_`. (principles:18, 36)

### Architecture Decisions
No `.bober/architecture/*.md` ADR applies directly to the hub renderer. The judge encodes the relevant invariants inline (judge.ts:1-16: deterministic JS sort, LLM never emits final order; fail-closed reconcile). The renderer inherits "judge order is final."

### Other Docs
`research:146-159` (cited in the contract) frames priority.md as a browsable Obsidian/Dataview note written by a local filesystem op into the kb-hub sibling vault.

---

## 6. Testing Patterns

### Unit Test Pattern — fake LLM client (`ScriptedClient`)
**Source:** `src/hub/judge.test.ts:7-20`
```ts
class ScriptedClient implements LLMClient {
  readonly calls: ChatParams[] = [];
  private idx = 0;
  constructor(private readonly responses: string[]) {}
  async chat(params: ChatParams): Promise<ChatResponse> {
    this.calls.push(params);
    const text = this.responses[Math.min(this.idx, this.responses.length - 1)] ?? "";
    this.idx += 1;
    return { text, toolCalls: [], stopReason: "end", usage: { inputTokens: 3, outputTokens: 5 } };
  }
}
```
**Rule:** Inject this into `runHubPriority` (or directly into `rankFindings`). For a **filtered/decision** test that wants deterministic findings without exercising the LLM, prefer `parseScope({ mode: "filtered", ... })` which makes `rankFindings` do ZERO LLM calls (judge.ts:181-187) — pass `new ScriptedClient([])`. For general/decision you script `RELEVANT` + 4 lens responses per finding (judge.test.ts:46-52, 64-71).

### Unit Test Pattern — stdout capture (vitest spy)
**Source:** `src/cli/commands/hub.test.ts:67-73`
```ts
const writes: string[] = [];
vi.spyOn(process.stdout, "write").mockImplementation((d: unknown) => { writes.push(String(d)); return true; });
runHubList(new FactStoreFindingSource(store, HUB_SCOPE));
const out = writes.join("");
expect(out).toContain(FINDING_A.title);
```
Spy stderr the same way (medical.test.ts:82-87) to assert the missing-dir message.

### Unit Test Pattern — temp sibling stores + file-write assertion
**Seed a sibling FactStore — `src/hub/collector.test.ts:32-48`:**
```ts
async function seedRepo(repoRoot: string, ids: string[]): Promise<void> {
  await ensureFactsDir(repoRoot);
  const store = new FactStore(factsDbPath(repoRoot)); // default (non-WAL)
  for (const id of ids) {
    store.insertFact({ scope: HUB_SCOPE, subject: id, predicate: "finding",
      value: findingJson(id), confidence: 1, sourceRunId: null, tValid: T, tCreated: T });
  }
  store.close();
}
```
**Temp-dir lifecycle — `src/hub/collector.test.ts:1-9, 53-61`:**
```ts
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
beforeEach(async () => { tmp = await mkdtemp(join(tmpdir(), "bober-hub-")); });
afterEach(async () => { await rm(tmp, { recursive: true, force: true }); });
```
**Assert priority.md was written (use `readFile`/`stat` on `<kb-hub>/priority.md`):** create `join(tmp, "kb-hub")` with `mkdir` before calling the core, seed two sibling repos under `tmp`, call `runHubPriority(findings, scope, new ScriptedClient([...]), join(tmp,"kb-hub"), NOW)`, then `await readFile(join(tmp,"kb-hub","priority.md"),"utf-8")` and assert frontmatter + rows + stdout ranks.
**exitCode lifecycle — `src/cli/commands/hub.test.ts:38-47`:** save/restore `process.exitCode` in `beforeEach`/`afterEach` (set to 0 before each, restore after) so the missing-dir test can assert `process.exitCode === 1`.

**Runner:** vitest. **Assertion:** `expect(...).toContain/toEqual/toHaveLength`. **Mock:** `vi.spyOn(process.stdout/stderr, "write")`; real temp dirs (no fs mocks). **File naming:** collocated `*.test.ts`. **Location:** next to source.

### E2E Test Pattern
N/A — agent-bober is a CLI/library; no Playwright. (principles:48). Command behavior is covered by the DI-core unit tests above.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/commands/hub.ts` (existing `list` + `runHubList`/`registerHubCommand`) | self (you edit it) | medium | Adding imports + two subcommands is additive; do NOT change `runHubList` or `registerHubCommand` signatures. Keep the `list` block byte-stable. |
| `src/cli/index.ts` (command registry calling `registerHubCommand`) | `hub.ts` export | low | `registerHubCommand` signature unchanged → no caller break. |
| `src/hub/collector.ts`, `repo-resolver.ts`, `judge.ts`, `scope.ts` | imported, unchanged | low | You only IMPORT these. Do not edit. Their tests must stay green. |
| sibling source FactStores | read-only via `collectFindings` (opens `{readonly:true}`) | low | nonGoal/sc: must NOT modify any sibling store. `collectFindings` already opens readonly (collector.ts:26); never open a writable handle on a sibling. |
| `src/config/schema.ts` | NOT edited | low | Do NOT add `hub` field — read raw (Sprint 1-2 contract). |

### Existing Tests That Must Still Pass
- `src/cli/commands/hub.test.ts` — tests `runHubList` (sc-1-4); your edits to hub.ts must not change its behavior. Extend this file with priority/decide tests.
- `src/hub/judge.test.ts` — `rankFindings` order/fail-closed; you only call it, so it must stay green.
- `src/hub/collector.test.ts`, `scope.test.ts`, `repo-resolver.test.ts`, `finding-source.test.ts` — unchanged modules; verify green.
- `src/cli/commands/chat.test.ts` — confirms the `createClient(providers.chat, ...)` shape you are mirroring; unaffected but good cross-reference.

### Features That Could Be Affected
- **`bober hub list`** (Sprint 1-2) — shares `resolveConfiguredRepos`/`resolveSiblingRepos`/`collectFindings` in the same file. Verify `list` still prints findings after you add imports/subcommands.
- **Sibling repos (medical/finance kb-* vaults)** — the collect path reads their FactStores; confirm read-only (no mtime/size change — collector.test.ts:95-106 already guards this for the collector, but re-verify no writable handle is introduced in the new action).

### Recommended Regression Checks
1. `npm run build` — zero TS errors (sc-4-5, hard gate).
2. `npx vitest run src/hub/ src/cli/commands/hub.test.ts` — new renderer + command tests + existing hub tests green.
3. `npx vitest run src/cli/commands/chat.test.ts src/hub/judge.test.ts src/hub/collector.test.ts` — unchanged dependencies green.
4. `npm run lint` — `consistent-type-imports` + unused-vars gates (principles:19).
5. Manual reasoning check: confirm no `writeFile`/`insertFact`/writable `FactStore` targets any sibling repo path — only `<outVault>/priority.md`.

---

## 8. Implementation Sequence

1. **`src/hub/priority-md.ts`** — PURE `renderPriorityMd(ranked, scopeLabel, now)`. Hand-rolled frontmatter (mirror lab-note.ts:95-109), table with 7 columns + rationale section. `import type { Finding }`.
   - Verify: `npx vitest run src/hub/priority-md.test.ts` — frontmatter keys (`generatedAt`/`scope`/`count`) present, one table row per finding, pipes escaped, no re-sort.
2. **`src/hub/hub-config.ts`** — `resolveOutVault(projectRoot)` (raw `hub.outVault` else `<parent>/kb-hub`, ABSOLUTE) + `priorityMdPath(outVault)`. `node:path` + `readJson`.
   - Verify: unit-assert absolute path + default + override (temp projectRoot with a `bober.config.json` containing `hub.outVault`).
3. **`src/cli/commands/hub.ts`** — add imports; export `runHubPriority(findings, scope, llm, outVault, now)` DI core (missing-dir gate → exitCode=1; rank→render→ensureDir(dirname)→writeFile→print ranks); add `priority` (filtered/general) + `decide <expr>` (parse `X vs Y` → decision) commander actions that build the real client (chat.ts:33-39) and delegate. Keep `list`/`runHubList`/`registerHubCommand` byte-stable.
   - Verify: `npm run build` green; `registerHubCommand` signature unchanged.
4. **`src/hub/priority-md.test.ts` + `src/cli/commands/hub.test.ts`** — renderer snapshot test; priority test (two seeded siblings + kb-hub dir + ScriptedClient → asserts `<kb-hub>/priority.md` written + stdout ranks); decide test (decision scope keeps only X/Y-relevant); missing-dir test (no kb-hub → clear stderr + `process.exitCode === 1`, no throw); sibling-store-unchanged assertion.
   - Verify: `npx vitest run src/hub/ src/cli/commands/hub.test.ts`.
5. **Full verification** — `npm run build` (sc-4-5) + `npx vitest run` (or targeted suites above) + `npm run lint`.

---

## 9. Pitfalls & Warnings

- **No `yaml`/`js-yaml` dependency exists** (verified in package.json). Hand-roll the frontmatter — do NOT add a runtime dep (principles). Do NOT import `src/vault/frontmatter.ts` or `src/medical/lab-note.ts` (both warn against cross-import); mirror the idiom inline.
- **Renderer must NOT re-rank** (nonGoal). `rank` = `index + 1` over the array `rankFindings` returned. No `.sort()` in priority-md.ts.
- **Pipe characters break Dataview tables.** Strip/escape `|` from `title`/cell text before emitting a row.
- **`dueBy` is optional** (finding.ts:19). Emit `""` (empty cell) when undefined — do not print `undefined`.
- **Missing-kb-hub-dir must NOT throw.** Gate with `fileExists(outVault)`; on miss → `chalk.red` stderr + `process.exitCode = 1` + `return` (medical.ts:67-75). Do NOT `mkdir` the vault root (generatorNotes); only the file's own parent (which equals outVault, already present).
- **Do NOT edit `config/schema.ts`.** `hub.outVault` is read raw via `readJson` (mirror `resolveConfiguredRepos`, hub.ts:59-73). Adding a Zod field would contradict Sprint 1-2.
- **`process.exitCode` leaks across tests.** Save/restore it in `beforeEach`/`afterEach` (hub.test.ts:38-47) or a later suite will see a stale non-zero code.
- **Sibling stores are READ-ONLY.** `collectFindings` opens `{readonly:true}` (collector.ts:26). Never introduce a writable `FactStore`/`writeFile` against a sibling — only `<outVault>/priority.md` is written (nonGoal: "Do not write into any sibling repo other than the kb-hub output vault").
- **Inject the clock.** `renderPriorityMd` takes `now: Date`; use `now.toISOString()` for `generatedAt`. Never call `Date.now()`/`new Date()` inside the pure renderer (judge/lab-note precedent) — the action passes `new Date()` at the CLI boundary.
- **`import type` for `Finding`, `Scope`, `LLMClient`** — type-only imports are a lint gate (principles:35). Value imports for `parseScope`, `rankFindings`, `renderPriorityMd`, `createClient`, etc.
- **`.js` extensions** on every new relative import (`./finding.js`, `./hub-config.js`, `../../hub/priority-md.js`, `../../providers/factory.js`).
- **`decide <expr>` parsing:** split on `" vs "` case-insensitively; if it does not yield two non-empty parts, print a usage error + `process.exitCode = 1` + return (don't pass a malformed decision scope to the judge).
