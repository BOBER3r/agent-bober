# Sprint Briefing: Online research-latest-findings + vault notes, schedulable research-job (egress-gated)

**Contract:** sprint-spec-20260628-medical-analysis-5
**Generated:** 2026-06-28T00:00:00.000Z

> This sprint is almost entirely **wiring existing pieces**. You implement two NEW pure-ish files
> (`src/medical/research/research-note.ts`, `src/medical/research/online-research.ts`) plus one CLI
> subcommand. You CALL `LiteratureRetriever.retrieve` + `synthesizeGrounded` + `buildMedicalInferenceClient`
> + `writeFinding` — you do NOT reimplement any of them. **Do not touch `src/medical/engine.ts`.**

Three load-bearing invariants (the whole sprint is judged on these):
- **(a) sc-5-2** axis OFF => return `{ disabled: true, notesWritten: 0, findingsWritten: 0 }`, ZERO egress, `MedlineSource` never constructed/invoked.
- **(b) sc-5-4** critic-reject / abstain (`answer.abstained === true`) => write NO clinical note for that topic; count it as abstained.
- **(c) sc-5-5** synthesis model fail-closes to the LOCAL Ollama default via `buildMedicalInferenceClient` unless `cloud-inference` is on.

---

## 1. Target Files

### src/medical/research/online-research.ts (create) — the schedulable entrypoint

**Signature (from generatorNotes + DoD):**
```ts
export interface ResearchSummary { notesWritten: number; findingsWritten: number; disabled: boolean; }

export async function runResearchJob(
  projectRoot: string,
  config: BoberConfig,
  opts: { markers: string[]; now: string },   // clock injected — NEVER Date.now() here
  deps: ResearchDeps = {},
): Promise<ResearchSummary>
```
- **NonGoal:** `runResearchJob` is the schedulable entrypoint imported by `spec-20260628-research-scheduler` — keep it a plain exported async fn, deps-injectable, never-throw-ish (the CLI owns exit codes). The scheduler passes `markers` + `now`.
- **Gating order (load-bearing, mirrors `runImportLabs` at `src/cli/commands/medical.ts:165-178`):**
  1. `const egress = EgressGuard.fromConfig(config)`
  2. `if (!egress.isAllowed("literature-retrieval")) return { disabled: true, notesWritten: 0, findingsWritten: 0 };` — **return BEFORE constructing any `LiteratureRetriever`/`MedlineSource`** (sc-5-2 zero-egress).
  3. Resolve vaultDir (see §3 vault resolution).
  4. Build synthesis client ONCE: `const { client, model } = buildMedicalInferenceClient(config, egress, deps.clientFactory)` (sc-5-5 fail-closed). Mirror `recommend.ts:200-211` / `engine.ts:402-404`.
  5. For each `marker`: `retriever.retrieve(query)` -> `synthesizeGrounded(query, outcome, client, footer, model)` -> if `answer.abstained` skip+count abstained, else write research note (++notesWritten) and optionally a watch finding (++findingsWritten).
  6. `return { disabled: false, notesWritten, findingsWritten }`.

### src/medical/research/research-note.ts (create) — PURE citation-frontmatter serializer

**Signature:**
```ts
export function serializeResearchNote(marker: string, answer: MedicalAnswer, now: string): string;
export function researchNotePath(vaultDir: string, marker: string, now: string): string; // <vault>/research/<YYYY-MM-DD>-<marker>.md
```
- PURE: no fs, no clock, no LLM (mirrors `finding.ts` purity contract `finding.ts:1-14`). `now` is the injected ISO string; derive `<date>` as `now.slice(0,10)`.
- See §2 "Research note serialization" for the citation-frontmatter recipe + the nested-object pitfall.

### src/cli/commands/medical.ts (modify) — add `medical research` subcommand

Add a new `.command("research")` inside `registerMedicalCommand` (`src/cli/commands/medical.ts:227-452`), following the `recommend` subcommand template (`medical.ts:408-451`): resolve root, `loadConfig`, **read the clock ONLY here** (`const now = new Date().toISOString()`), default the marker set when `--marker` omitted, call `runResearchJob`, print "ran" vs "disabled", never throw (`process.exitCode = 1` on error).

**Imported by:** `src/cli/index.ts` (or wherever `registerMedicalCommand` is wired) — no signature change, additive only.

---

## 2. Patterns to Follow

### Pattern A — Egress short-circuit BEFORE any source construction (sc-5-2)
**Source:** `src/medical/retrieval/literature.ts:32-42` (the canonical zero-egress proof) and CLI `src/cli/commands/medical.ts:169-178`
```ts
// literature.ts:32-42 — isAllowed check MUST precede source call
async retrieve(query: string): Promise<RetrievalOutcome> {
  if (!this.egress.isAllowed("literature-retrieval")) {
    return { kind: "disabled" };            // NO network, NO MedlineSource method called
  }
  try { return await this.source.fetchPassages(query); }
  catch { return { kind: "abstain", reason: "source-error" }; }
}
```
**Rule:** In `runResearchJob`, return `{ disabled: true, ... }` the instant `!egress.isAllowed("literature-retrieval")` — do not even construct a `LiteratureRetriever` (whose default ctor `literature.ts:17-20` would `new MedlineSource(egress)`). Construct the retriever lazily inside the axis-ON branch only.

### Pattern B — synthesizeGrounded is the ONLY synthesis call (fail-closed critic gate)
**Source:** `src/medical/retrieval/literature.ts:277-340`
```ts
export async function synthesizeGrounded(
  query: string, outcome: RetrievalOutcome, llm: LLMClient, footer: string,
  model: string = SYNTHESIS_MODEL,                       // SYNTHESIS_MODEL = "ollama/llama3" (literature.ts:47)
): Promise<GroundedResult>                               // GroundedResult = { answer: MedicalAnswer; verdict: CriticVerdict } (literature.ts:52-55)
```
- For non-grounded outcomes (`disabled`/`abstain`) it returns an abstained answer (`literature.ts:284-288`).
- For grounded outcomes it runs synth -> critic -> one re-synth -> re-critic, and **fail-closes to an abstained answer on a second critic reject** (`literature.ts:336-339`). The grounding critic itself fails closed (`grounding-critic.ts:206`).
**Rule:** Call `synthesizeGrounded(query, outcome, client, footer, model)`. Branch ONLY on `result.answer.abstained`. If `true` -> abstain (write nothing, count abstained — sc-5-4). If `false` -> `result.answer.citations` is guaranteed length >= 1 (`literature.ts:84-90,179-187`); write the research note. You may also persist `result.verdict` (`approve|reject-abstained|error-abstained`, `types.ts:74`) into the note/finding for provenance, but it is NOT required.

### Pattern C — Fail-closed synthesis-model selection (sc-5-5)
**Source:** `src/medical/inference.ts:31-49`
```ts
export function buildMedicalInferenceClient(config, egress, factory = createClient): { client: LLMClient; model: string } {
  const inf = config.medical?.inference;
  const isLocal = (inf?.provider ?? "openai-compat") === "openai-compat"
               && (inf?.endpoint ?? "http://localhost:11434/v1").includes("localhost");
  if (!isLocal && !egress.isAllowed("cloud-inference")) {        // FAIL CLOSED
    return { client: factory("openai-compat", "http://localhost:11434/v1", undefined, "llama3"), model: "llama3" };
  }
  ...
}
```
**Rule:** Get the synthesis client via `buildMedicalInferenceClient(config, egress, deps.clientFactory)` — never `new`/`createClient` a cloud provider yourself. Thread `deps.clientFactory` through (exactly like `recommend.ts:118,140,203`) so sc-5-5 can spy and assert the local args.

### Pattern D — Disclaimer footer for every synthesis call
**Source:** `src/medical/disclaimer.ts:19-25`
```ts
const footer = new DisclaimerComposer().footer();   // versioned wellness footer string
```
**Rule:** Pass `footer` as the 4th arg to `synthesizeGrounded`. (engine.ts builds it the same way before its `synthesizeGrounded` call at `engine.ts:405`.)

### Pattern E — Research note serialization (citation frontmatter) + the nested-object PITFALL
**Source vault serializer:** `src/vault/frontmatter.ts:145-164` and finding serializer `src/medical/analysis/finding.ts:83-113`
```ts
// frontmatter.ts:145-164 — serializeFrontmatter handles ONLY scalars + arrays-of-scalars
for (const [key, val] of Object.entries(frontmatter)) {
  if (Array.isArray(val)) { lines.push(`${key}:`); for (const item of val) lines.push(`  - ${String(item)}`); }
  else lines.push(`${key}: ${String(val)}`);
}
```
**PITFALL:** `Citation` is an OBJECT `{ title; url; source: "medlineplus" }` (`types.ts:33-37`). Passing `citations: Citation[]` straight into `serializeFrontmatter` renders `- [object Object]`. **Flatten** it. Recommended frontmatter for `serializeResearchNote` (all scalar/array-of-string, so `serializeFrontmatter` is safe):
```yaml
title: Latest evidence — ldl
domain: medical
type: research
marker: ldl
source: medlineplus            # scalar — satisfies sc-5-3 "source 'medlineplus'"
citationTitles:                # array of strings (answer.citations.map(c => c.title))
  - Cholesterol
citationUrls:                  # array of strings (answer.citations.map(c => c.url))
  - https://medlineplus.gov/cholesterol.html
surfacedAt: 2026-06-28T...     # opts.now (injected)
status: open
```
Body = `answer.body` + the footer. sc-5-3 only requires title/url/source present in frontmatter — the flattened arrays + scalar `source` satisfy it and keep you inside the hand-rolled serializer's capabilities. (If you prefer a nested `citations:` YAML list of objects, you must hand-roll those lines yourself — `serializeFrontmatter` cannot.)

**Reuse decision:** Do NOT reuse `serializeFindingToMarkdown` for the research note — it is finding-shaped (forces `id/kind/urgency/severity` keys, `finding.ts:83-113`). Build the research note with `serializeFrontmatter` directly (pure) and write it with `writeFile`+`ensureDir` (Pattern F). `src/vault/note-io.ts:38-41 writeNote` is also viable but requires constructing a `VaultNote { frontmatter, body, path }` (`frontmatter.ts:172-182`); the direct `serializeFrontmatter`+`writeFile` path mirrors the existing `writeFinding` and is simplest.

### Pattern F — File write with parent-dir creation
**Source:** `src/medical/analysis/finding-writer.ts:27-33`
```ts
const notePath = join(vaultDir, "findings", `${finding.id}.md`);
await ensureDir(dirname(notePath));            // ensureDir from ../../utils/fs.js (utils/fs.ts:45)
await writeFile(notePath, serialized, "utf-8");
return notePath;
```
**Rule:** For research notes write to `join(vaultDir, "research", `${date}-${marker}.md`)`. Use `node:fs/promises writeFile` + `ensureDir(dirname(...))`. No sync fs (principles).

### Pattern G — Optional 'new evidence' watch Finding (reuse sprint-1 writer)
**Source:** `src/medical/analysis/finding.ts:36-70` + `finding-writer.ts:27-33`
```ts
const finding: MedicalFinding = {
  id: findingId("medical", marker, "new-evidence"),   // deterministic, idempotent (finding.ts:65-70)
  domain: "medical",
  title: `New evidence on ${marker}`,
  kind: "watch",                                        // FindingKind union: action|watch|risk|question (finding.ts:26)
  urgency: 2, severity: 2,
  evidence: answer.citations.map(c => c.url),
  surfacedAt: opts.now,                                 // injected — never wall-clock
  tags: ["research", marker],
  status: "open",
};
await writeFinding(vaultDir, finding);                  // -> <vaultDir>/findings/<id>.md
```
**Rule:** Emit a watch finding only for non-abstained markers; increment `findingsWritten` per finding written. Reuse `writeFinding` (do NOT hand-roll finding I/O).

### Pattern H — CLI subcommand (testable run* helper + never-throw)
**Source:** `src/cli/commands/medical.ts:408-451` (recommend) and `351-405` (review)
```ts
medicalCmd.command("research")
  .description("Retrieve latest MedlinePlus evidence for markers and write vault research notes (egress-gated)")
  .option("--marker <m>", "marker to research (default: a built-in marker set)")
  .action(async (opts: { marker?: string }) => {
    const projectRoot = await resolveRoot();
    try {
      const config = await loadConfig(projectRoot);
      const now = new Date().toISOString();                 // clock read ONLY here (medical.ts:419)
      const markers = opts.marker ? [opts.marker] : ["ldl", "hdl", "a1c"]; // default set
      const summary = await runResearchJob(projectRoot, config, { markers, now });
      if (summary.disabled) {
        process.stdout.write(chalk.yellow("literature-retrieval egress not enabled — research skipped (zero egress)\n"));
      } else {
        process.stdout.write(chalk.green("Research complete\n"));
        process.stdout.write(`  notes written:    ${summary.notesWritten}\n`);
        process.stdout.write(`  findings written: ${summary.findingsWritten}\n`);
      }
    } catch (err) {
      process.stderr.write(chalk.red(`Failed to run research: ${err instanceof Error ? err.message : String(err)}\n`));
      process.exitCode = 1;                                  // MUST NOT throw (medical.ts:449)
    }
  });
```
**Rule:** Exit 0 on both "ran" and "disabled" (sc-5-7). Only set `process.exitCode = 1` in the catch. Keep `runResearchJob` deps-free at the CLI call site (production passes no deps).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `LiteratureRetriever` | `src/medical/retrieval/literature.ts:16-43` | `new (egress, source?=new MedlineSource(egress))` ; `retrieve(query): Promise<RetrievalOutcome>` | Egress-gated MedlinePlus retrieval; sync `{disabled}` when axis off |
| `synthesizeGrounded` | `src/medical/retrieval/literature.ts:277-340` | `(query, outcome, llm, footer, model?) => Promise<{answer, verdict}>` | Fail-closed grounding-critic synthesis; abstains on reject |
| `MedlineSource` | `src/medical/retrieval/medline-source.ts:123-165` | `new (egress, fetchImpl?=fetch)` ; `fetchPassages(query)` | The ONE network-excepted file; `assertAllowed`-first (`:145`). DO NOT construct when axis off |
| `getGroundingVerdict` | `src/medical/retrieval/grounding-critic.ts:170-207` | `({llm,model,question,answerBody,passages}) => Promise<GroundingVerdict>` | Critic; fail-closed `reject` on parse exhaustion (`:206`). Called internally by synthesizeGrounded — you don't call it |
| `buildMedicalInferenceClient` | `src/medical/inference.ts:31-56` | `(config, egress, factory?=createClient) => {client, model}` | Fail-closed local-vs-cloud synthesis client resolver |
| `EgressGuard.fromConfig` | `src/medical/egress.ts:25-32` | `(config) => EgressGuard` ; `isAllowed(axis)` `:35-48` | Three independent axes, all default false |
| `DisclaimerComposer` | `src/medical/disclaimer.ts:19-25` | `new().footer(): string` | Versioned wellness footer for each answer |
| `writeFinding` | `src/medical/analysis/finding-writer.ts:27-33` | `(vaultDir, finding) => Promise<string>` | Write a MedicalFinding to `<vaultDir>/findings/<id>.md` |
| `findingId` | `src/medical/analysis/finding.ts:65-70` | `(domain, biomarker, ruleKey) => string` | Deterministic 16-hex finding id (no clock) |
| `serializeFrontmatter` | `src/vault/frontmatter.ts:145-164` | `(frontmatter, body) => string` | Scalars + arrays-of-scalars -> YAML note (see Pattern E pitfall) |
| `writeNote` / `readNote` / `listNotes` | `src/vault/note-io.ts:27-51` | `(VaultNote)=>Promise<void>` / `(path)=>Promise<VaultNote>` / `(dir)=>Promise<string[]>` | Vault note fs I/O (alternative to writeFile) |
| `ensureDir` / `findProjectRoot` | `src/utils/fs.ts:45,58` | `(path)=>Promise<void>` / `()=>Promise<string|undefined>` | Mkdir -p / locate project root |
| `Citation` / `MedicalAnswer` | `src/medical/types.ts:33-46` | `{title,url,source:"medlineplus"}` / `{body,abstained,citations,disclaimerFooter,shortCircuit}` | Shapes returned by synthesizeGrounded |
| `MedicalFinding` | `src/medical/analysis/finding.ts:36-52` | interface (id,domain,title,kind,urgency,severity,evidence,surfacedAt,tags,status) | Watch-finding shape |

Directories reviewed: `src/utils/` (fs.ts), `src/vault/` (frontmatter, note-io, types), `src/medical/`, `src/medical/analysis/`, `src/medical/retrieval/`. No generic `lib/`/`helpers/`/`shared/`/`common/` dir exists for this module — utilities live under `src/medical/**` and `src/vault/**` (all listed above).

---

## 4. Prior Sprint Output

### Sprint 1 (307e5e7): src/medical/analysis/ — finding writer + vault dir resolution
**Created:** `src/medical/analysis/finding.ts` (exports `MedicalFinding`, `FindingKind`, `findingId`, `serializeFindingToMarkdown`), `src/medical/analysis/finding-writer.ts` (exports `writeFinding`, `writeDashboard`).
**Vault dir resolution (REUSE verbatim):** `src/medical/analysis/review-pass.ts:78-79`
```ts
const vaultDir = config.medical?.vaultDir ?? join(projectRoot, ".bober", "medical", "vault");
```
**Connection:** Research notes go to `<vaultDir>/research/`, watch findings go to `<vaultDir>/findings/` via the SAME `writeFinding`. Reuse this exact `vaultDir` line in `runResearchJob`. The `now` injection / "clock only at CLI boundary" rule (`finding.ts:4-6`, `review-pass.ts:5`) applies to your new files too.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` was read for this briefing, but the enforced conventions are visible in code and MUST be followed:
- **Clock only at the CLI boundary** — `now` is an injected param everywhere downstream (`finding.ts:4-6`, `medical.ts:99,419`, `review-pass.ts:5`). Never call `Date.now()`/`new Date()` in `online-research.ts` or `research-note.ts`.
- **No sync fs** — use `node:fs/promises` (`finding-writer.ts:8`).
- **Egress is code-enforced, default off (ADR-6)** — all three axes default false (`egress.ts:1-5`, `schema.ts:376-387`).
- **Audit logs are IDs/enums only — never PHI / health values / prompt text** (`types.ts:64-92`, `medical.ts:116,202`). If you append an AuditLog entry, use enum events only (e.g. `"answer"`/`"abstain"`); do NOT log marker values or note text.

### Architecture Decisions
- **ADR-6** (egress axes): `MedlineSource` is the single ESLint-network-excepted file (`medline-source.ts:1-3,108-122`); `assertAllowed("literature-retrieval")` runs before any fetch (`medline-source.ts:144-145`). Your new files MUST NOT import `node-fetch`/global `fetch`/network modules — go only through `LiteratureRetriever`.
- Cloud-inference and literature-retrieval are **independent** axes (`egress.ts:7-22`); enabling literature does NOT enable cloud (`literature.test.ts:223-230`).

### Other Docs
`config.medical` schema: `src/config/schema.ts:376-402` — `egress.{cloudInference,literatureRetrieval,deviceConnection}` (`:378-387`), `inference.{provider,endpoint,model}` (`:393-399`), `vaultDir` (`:400-401`).

---

## 6. Testing Patterns

### Unit Test Pattern — injected fakes, no network (Vitest)
**Runner:** vitest · **Assertions:** `expect` · **Mocks:** `vi.fn()` / `vi.spyOn` · **Naming:** `*.test.ts` co-located · **Location:** beside source.

**(sc-5-2) axis OFF — retriever/source never touched.** Adapt `literature.test.ts:76-86`:
```ts
it("axis OFF => {disabled:true}, writes nothing, MedlineSource never constructed", async () => {
  const mlSpy = vi.spyOn(MedlineSource.prototype, "fetchPassages");
  const retrieveSpy = vi.fn();                              // inject a fake retriever
  const summary = await runResearchJob(tmpRoot, {} as BoberConfig,
    { markers: ["ldl"], now: NOW }, { retriever: { retrieve: retrieveSpy } as any });
  expect(summary).toEqual({ disabled: true, notesWritten: 0, findingsWritten: 0 });
  expect(retrieveSpy).not.toHaveBeenCalled();
  expect(mlSpy).not.toHaveBeenCalled();
  expect(await readdir(join(tmpRoot, ".bober/medical/vault/research")).catch(() => [])).toEqual([]);
});
```
> Stronger proof: since axis-off returns before constructing the retriever, the cleanest assertion is that an injected `deps.retriever.retrieve` spy is never called AND no `research/` dir is created.

**LLM fake (grounded synthesis path).** ScriptedClient pattern (`recommend.test.ts:28-38`) is required because `synthesizeGrounded` makes a SYNTH call then a CRITIC call (which needs JSON). One fixed-text fake (`literature.test.ts:32-41`) is NOT enough for the grounded gate:
```ts
class ScriptedClient implements LLMClient {           // recommend.test.ts:28-38
  readonly calls: ChatParams[] = []; private idx = 0;
  constructor(private readonly responses: string[]) {}
  async chat(p: ChatParams): Promise<ChatResponse> {
    this.calls.push(p);
    const text = this.responses[Math.min(this.idx, this.responses.length - 1)] ?? "";
    this.idx += 1;
    return { text, toolCalls: [], stopReason: "end", usage: { inputTokens: 3, outputTokens: 5 } };
  }
}
const APPROVE = '{"verdict":"approve","feedback":""}';   // recommend.test.ts:42
// sequence: [ "<supported answer>", APPROVE ]  => synthesizeGrounded approves on first critique
```

**(sc-5-3) grounded => note with citation frontmatter.** Inject a fake retriever returning `{ kind:"grounded", passages:[{title,url,text,source:"medlineplus"}] }` (`literature.test.ts:19-28`) + a ScriptedClient `["<answer>", APPROVE]`. Assert a file under `<tmp>/.bober/medical/vault/research/<date>-ldl.md` exists and its contents include the passage `url`, its `title`, and `source: medlineplus` (read via `readFile`, parse via `parseFrontmatter` `frontmatter.ts:53`).

**(sc-5-4) critic reject => abstain, no note.** ScriptedClient `["<answer>", REJECT, "<answer2>", REJECT]` (`REJECT = '{"verdict":"reject","feedback":"..."}'`, `recommend.test.ts:44`). `synthesizeGrounded` then returns `{answer:{abstained:true...}, verdict:"reject-abstained"}` (`literature.ts:336-339`). Assert `summary.notesWritten === 0` and no `research/` file for that marker.

**(sc-5-5) cloud OFF => local synthesis client.** Factory-spy pattern (`inference.test.ts:18-22,45-57`):
```ts
const spy = vi.fn(() => ({ chat: new ScriptedClient(["ans", APPROVE]).chat.bind(...) }));
// config: medical.inference={provider:"anthropic",model:"claude-x"}, egress cloudInference=false, literatureRetrieval=true
await runResearchJob(tmpRoot, cfg, { markers:["ldl"], now: NOW }, { retriever: groundedFake, clientFactory: spy });
expect(spy).toHaveBeenCalledWith("openai-compat", "http://localhost:11434/v1", undefined, "llama3");
expect(spy).not.toHaveBeenCalledWith("anthropic", expect.anything(), expect.anything(), expect.anything());
```

**(sc-5-6) summary counts.** With one grounded marker + watch finding enabled, assert `{ disabled:false, notesWritten:1, findingsWritten:1 }`.

**Temp-vault fixture (keeps CI offline) — `review-pass.test.ts:23-29`:**
```ts
let tmpRoot: string;
beforeEach(async () => { tmpRoot = await mkdtemp(join(tmpdir(), "bober-research-")); });
afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }); });
```
There is no live network in any test: retrieval is faked (`deps.retriever`), synthesis is faked (`clientFactory`/ScriptedClient). `MedlineSource`'s default global `fetch` is NEVER reached.

### E2E Test Pattern
Not applicable — this is a CLI/library sprint with Vitest unit tests only (no Playwright in this module).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/commands/medical.ts` | new `runResearchJob` import + new subcommand | low | Additive `.command("research")`; existing subcommands (`import`, `import-labs`, `whoop`, `supplements`, `profile`, `review`, `recommend`) unchanged |
| `src/cli/index.ts` (wires `registerMedicalCommand`) | `registerMedicalCommand` | low | Signature unchanged — no edit needed |
| `src/medical/retrieval/literature.ts` | imported (read-only) by new code | none | You only CALL `synthesizeGrounded`/`LiteratureRetriever`; do not edit |
| `src/medical/inference.ts`, `src/medical/egress.ts`, `src/medical/analysis/finding*.ts` | imported (read-only) | none | Reuse only; no edits |

### Existing Tests That Must Still Pass
- `src/medical/retrieval/literature.test.ts` — covers retrieve disabled/grounded + synthesize; unaffected (you reuse, not modify).
- `src/medical/retrieval/grounded-gate.test.ts` + `grounding-critic.test.ts` — cover the fail-closed gate; unaffected.
- `src/medical/engine.test.ts` (47KB) — covers the reactive literature path at `engine.ts:383-407`; **must remain green — confirm `engine.ts` is byte-unchanged** (NonGoal #4 / evaluatorNotes).
- `src/medical/inference.test.ts` — covers `buildMedicalInferenceClient`; you reuse it, must stay green.
- `src/medical/analysis/review-pass.test.ts`, `finding-writer.test.ts`, `finding.test.ts` — cover the sprint-1 finding writer you reuse; must stay green.
- Any CLI command test for `medical` — new subcommand is additive; existing assertions must stay green.

### Features That Could Be Affected
- **Reactive engine (`feat`/engine path)** — shares `LiteratureRetriever` + `synthesizeGrounded` (`engine.ts:385,405`). Verify the reactive `medical` answer flow still works (`engine.test.ts`). `runResearchJob` is a SEPARATE proactive entrypoint; it must NOT alter engine behaviour.
- **`spec-20260628-research-scheduler`** (downstream) — will import `runResearchJob`. Keep the exported signature `(projectRoot, config, {markers, now}, deps?) => Promise<{notesWritten, findingsWritten, disabled}>` stable; it is the schedulable-entrypoint contract.

### Recommended Regression Checks (run after implementation)
1. `npm run build` (tsc) — zero type errors (sc-5-1).
2. `npx vitest run src/medical/research/` — new tests green (sc-5-2..5-6).
3. `npx vitest run src/medical/engine.test.ts src/medical/retrieval/ src/medical/analysis/ src/medical/inference.test.ts` — no regressions in reused substrate.
4. `git diff --stat src/medical/engine.ts` — MUST be empty (NonGoal #4).
5. `npx vitest run` — full suite, no new failures (stopCondition).
6. Manual (sc-5-7): `bober medical research --marker ldl` prints ran/disabled and exits 0 (verify `echo $?` == 0).

---

## 8. Implementation Sequence (dependency-ordered)

1. **`src/medical/research/research-note.ts`** — PURE `serializeResearchNote(marker, answer, now)` + `researchNotePath(vaultDir, marker, now)`. Flatten `answer.citations` to `citationTitles[]`/`citationUrls[]` + scalar `source: medlineplus` (Pattern E). Depends only on `serializeFrontmatter` + `MedicalAnswer` type.
   - Verify: `serializeResearchNote("ldl", groundedAnswer, NOW)` returns a string containing the url, title, and `source: medlineplus`; no `[object Object]`.
2. **`src/medical/research/research-note.test.ts`** — assert frontmatter contains title/url/source; assert `researchNotePath` => `<vault>/research/2026-06-28-ldl.md`.
   - Verify: tests pass with no fs/network.
3. **`src/medical/research/online-research.ts`** — `runResearchJob`: `EgressGuard.fromConfig` -> axis-off early return `{disabled:true,0,0}` -> resolve vaultDir (`review-pass.ts:78-79`) -> `buildMedicalInferenceClient` (sc-5-5) -> build retriever (lazy, axis-on only) -> per marker: `retrieve` -> `synthesizeGrounded` -> abstained? skip : write research note (++notes) + optional watch finding (++findings) -> return summary. Deps interface `{ retriever?, llm?, clientFactory?, writeFindingFn?, now? }`.
   - Verify: types compile; axis-off path never references the retriever.
4. **`src/medical/research/online-research.test.ts`** — sc-5-2 (axis off / zero egress / MedlineSource spy), sc-5-3 (grounded note + citation frontmatter), sc-5-4 (reject => no note), sc-5-5 (factory spy local args), sc-5-6 (summary counts). Use `mkdtemp` temp vault + ScriptedClient + fake retriever.
   - Verify: `npx vitest run src/medical/research/` green.
5. **`src/cli/commands/medical.ts`** — add `.command("research")` (Pattern H) calling `runResearchJob`; clock read at CLI; default marker set; print ran/disabled; never throw.
   - Verify: `bober medical research --marker ldl` exits 0; `--help` lists `research`.
6. **Run full verification** — `npm run build`, `npx vitest run`, `git diff --stat src/medical/engine.ts` (empty).

---

## 9. Pitfalls & Warnings

- **Zero-egress proof (sc-5-2):** return `{disabled:true,...}` BEFORE constructing `LiteratureRetriever` — its default ctor `new MedlineSource(egress)` (`literature.ts:17-20`) is technically harmless (it doesn't fetch) but the evaluator asserts "MedlineSource never constructed/invoked." Safest: early-return so neither is constructed; inject `deps.retriever` for the axis-ON path and assert it's untouched when off.
- **Citation objects break `serializeFrontmatter`** (`frontmatter.ts:152-160` does `String(item)`): flatten to arrays-of-strings + scalar `source` (Pattern E), else you get `- [object Object]` and sc-5-3 fails.
- **Branch on `answer.abstained`, not on `verdict`:** `synthesizeGrounded` returns `verdict:"error-abstained"` for disabled/abstain outcomes too (`literature.ts:287,295`), and an abstained answer always has `citations: []`. Writing a note when `abstained===true` violates sc-5-4. Use `if (result.answer.abstained) { /* count abstained, write nothing */ }`.
- **Do NOT touch `src/medical/engine.ts`** (NonGoal #4) — the reactive literature path (`engine.ts:383-407`) and `engine.test.ts` must stay byte-identical. `runResearchJob` is a separate proactive entrypoint.
- **Clock discipline:** `now` is injected into `runResearchJob`; only the CLI `.action` calls `new Date().toISOString()` (`medical.ts:419`). Putting a clock read in `online-research.ts`/`research-note.ts` will fail the project's purity convention (and make notes non-deterministic).
- **Fail-closed synthesis model:** never call `createClient("anthropic", ...)` directly — only `buildMedicalInferenceClient(config, egress, deps.clientFactory)` (sc-5-5). Thread the factory so the spy can assert local args.
- **ESM imports:** use `.js` extensions on relative imports (NodeNext), e.g. `import { synthesizeGrounded } from "../retrieval/literature.js";` (see `recommend.ts:29`, `literature.ts:3`).
- **No global `fetch` / network imports** in your new files — ADR-6 restricts network to `medline-source.ts` only. Reach MedlinePlus solely via `LiteratureRetriever`.
- **Default marker set:** the CLI default when `--marker` omitted is your choice (e.g. `["ldl","hdl","a1c"]`); keep it small and documented. The scheduler will pass its own marker list, so `runResearchJob` itself takes `markers` explicitly (no internal default).
