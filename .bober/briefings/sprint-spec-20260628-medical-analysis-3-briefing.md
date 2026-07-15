# Sprint Briefing: Recommendation generation end-to-end + `bober medical recommend` CLI

**Contract:** sprint-spec-20260628-medical-analysis-3
**Generated:** 2026-06-28T00:00:00.000Z

> Wire the sprint-2 judge loop into a REAL recommendation path. Four new modules under
> `src/medical/recommend/` (context, urgency, recommend + tests) plus one `recommend` subcommand
> in `src/cli/commands/medical.ts`. **`engine.ts` is NO-TOUCH.** `runJudgeLoop` is IMPORTED, not
> re-implemented. Two highest-risk wiring points are called out in §9.

---

## 1. Target Files

### src/medical/recommend/context.ts (create)
`assembleRecommendationContext(projectRoot, config, { goal? }, deps?) -> { meds[], supplements[], conditions[], allergies[], goal? }`
Reads meds + supplements from a `FactStore`, conditions/allergies/goals from the profile reader.
**Most similar existing file:** `src/medical/analysis/review-pass.ts` (open-store / try / finally-close / inject-store-for-tests) and `src/medical/engine.ts:365-381` (FactStore graceful-open pattern).

### src/medical/recommend/urgency.ts (create)
`assignUrgencySeverity(llm, model, candidate, context) -> { urgency:1..5, severity:1..5, confidence:number }`
ONE bounded LLM call (`llm.chat({ model, system, messages, jsonObjectMode: true })`) + a NEVER-throwing
JSON validator that mirrors `validateLensVerdict` (lenses.ts:65-113) / `validateGroundingVerdict`
(grounding-critic.ts:40+). Clamp integers to 1..5. **Most similar existing file:** `src/medical/recommend/lenses.ts:48-113`.

### src/medical/recommend/recommend.ts (create)
`generateRecommendation(projectRoot, config, { question, goal?, now }, deps?) -> RecommendOutcome`
Builds `EgressGuard.fromConfig`, builds four lens clients (tier-diverse when cloud allowed, else local),
builds `generateCandidate`, calls `runJudgeLoop`, emits a Finding, appends audit. **Most similar:** `engine.ts:250-410` (gate ordering + audit) and `review-pass.ts:45-100` (vault resolve + writeFinding).

### src/cli/commands/medical.ts (modify)
Add a `recommend` subcommand mirroring the `review` action at **lines 349-373**.

**Relevant section to mirror (lines 349-373):**
```ts
  // ── medical review ────────────────────────────────────────────────────
  medicalCmd
    .command("review")
    .description("Run the deterministic proactive trend review pass and write Finding notes + dashboard")
    .action(async () => {
      const projectRoot = await resolveRoot();
      try {
        const config = await loadConfig(projectRoot);
        const now = new Date().toISOString();          // clock read ONLY at CLI boundary
        const result = await runProactiveReview(projectRoot, config, { now });
        process.stdout.write(chalk.green(`Proactive review complete\n`));
        ...
      } catch (err) {
        process.stderr.write(chalk.red(`Failed to run review: ${...}\n`));
        process.exitCode = 1;                          // MUST NOT throw
      }
    });
```
**New subcommand shape:** `.command("recommend <question>").option("--goal <g>", ...)` →
`.action(async (question, opts) => { const root = await resolveRoot(); const config = await loadConfig(root);
const now = new Date().toISOString(); const r = await generateRecommendation(root, config, { question, goal: opts.goal, now }); print r.kind; })`.
Wrap in try/catch → `process.exitCode = 1` on error, **never throw** (sc-3-7 exit 0).

**Imports the file already has (reuse):** `loadConfig` (line 11), `EgressGuard` (18), `AuditLog` (22),
`buildMedicalInferenceClient` (26), `chalk`, `findProjectRoot`/`resolveRoot` (10/33).
**Imported by:** `src/cli/index.ts` (command registration). Adding a subcommand is additive/low-risk.
**Test file:** no `medical.test.ts` for the CLI; the run* cores are tested via their module tests.

---

## 2. Patterns to Follow

### A. runJudgeLoop input contract — the EXACT shape sprint 3 must satisfy
**Source:** `src/medical/recommend/judge-panel.ts:89-97`
```ts
export async function runJudgeLoop(input: {
  question: string;
  generateCandidate: (prevFeedback?: string) => Promise<string>;
  lensClients: LensClients;          // { evidenceGrader, contraindicationChecker, conservativeClinician, optimizationLens }
  context: string;                   // a STRING — flatten your context object before passing
  redFlag: GuardrailSet;             // pass `new MedicalGuardrails()`
  maxRounds?: number;
  now?: string;
}): Promise<PanelOutcome>;
```
**Rule:** `context` is a plain `string` — serialize `{ meds, supplements, conditions, allergies, goal }` to text. `redFlag.evaluate` fires FIRST inside the loop (judge-panel.ts:107-126); do NOT call the guard again yourself before runJudgeLoop.

### B. PanelOutcome union members (what each carries) — types.ts:84-133
```ts
AcceptedOutcome   { outcome:"accepted"; accepted:true; recommendation:string; verdicts:Record<LensName,LensVerdict>; rounds:number }
RejectedOutcome   { outcome:"rejected"; accepted:false; reason:"contraindication-veto"|"no-consensus"; dissent:Record<LensName,string>; verdicts; rounds }
ShortCircuitOutcome { outcome:"short-circuit"; rule:string; cannedResponse:string }
RefuseOutcome     { outcome:"refuse"; rule:string; reason:string }
```
**Rule:** switch on `outcome.outcome`. `accepted` → action Finding (recommendation is the raw candidate STRING). `rejected` → question Finding (use `outcome.dissent`). `short-circuit`/`refuse` → canned escalation, NO finding.

### C. LensSpec / LensClients (the four real clients to build) — types.ts:57-68
```ts
export interface LensSpec { client: LLMClient; model: string; }
export interface LensClients {
  evidenceGrader: LensSpec; contraindicationChecker: LensSpec;
  conservativeClinician: LensSpec; optimizationLens: LensSpec;
}
```
**Rule:** each lens is just `{ client: LLMClient, model: string }`. A "real client" is any `createClient(...)` / `buildMedicalInferenceClient(...).client`. The lens system prompts + parsing already live in lenses.ts — you only supply client+model.

### D. Fail-closed model selection — inference.ts:31-49 (THE seam, sc-3-5)
```ts
export function buildMedicalInferenceClient(
  config: BoberConfig, egress: EgressGuard, factory: ClientFactory = createClient,
): { client: LLMClient; model: string } {
  const inf = config.medical?.inference;
  const isLocal = (inf?.provider ?? "openai-compat") === "openai-compat"
                  && (inf?.endpoint ?? "http://localhost:11434/v1").includes("localhost");
  if (!isLocal && !egress.isAllowed("cloud-inference")) {           // FAIL CLOSED
    return { client: factory("openai-compat", "http://localhost:11434/v1", undefined, "llama3"), model: "llama3" };
  }
  const model = inf?.model ?? "llama3";
  return { client: factory(inf?.provider ?? "openai-compat", inf?.endpoint ?? "http://localhost:11434/v1", undefined, model), model };
}
```
**Rule:** when `egress.isAllowed("cloud-inference") === false`, EVERY lens + the generator MUST resolve through this helper (returns local llama3). Construct NO cloud client. Accept `factory: ClientFactory` (inference.ts:17) as an injectable dep so the test can spy. Pass the SAME injected factory to both `buildMedicalInferenceClient` AND any `createClient` call on the tier branch.

### E. Tier diversity (cloud ON ONLY) — tier-policy.ts:75-82 + 26-71
```ts
tierPolicy.resolveTier("cheap")    -> { generator: DEEPSEEK_BLOCK }   // openai-compat deepseek @ api.deepseek.com
tierPolicy.resolveTier("standard") -> { generator: GROK_BLOCK }       // openai-compat grok @ api.x.ai/v1
tierPolicy.resolveTier("hard")     -> { generator: SONNET_BLOCK }     // anthropic sonnet
tierPolicy.resolveTier("frontier") -> { generator: OPUS_BLOCK }       // anthropic opus
// RoleProviderBlock = { provider: ProviderName; model: string; endpoint?: string | null }
```
**Rule:** ONLY inside `if (egress.isAllowed("cloud-inference"))` map each lens to a distinct block and build it with `factory(block.provider, block.endpoint ?? undefined, undefined, block.model)`. Use `.generator` from the `TieredRoleBlock`. The generator (`generateCandidate`'s client) can use one block too (e.g. `hard`/`frontier`).

### F. EgressGuard construction — egress.ts:25-35
```ts
const egress = EgressGuard.fromConfig(config);   // all axes default false
egress.isAllowed("cloud-inference")              // the ONLY axis sprint 3 reads
```

### G. Red-flag guard + canned escalation/audit — engine.ts:250-289 (REUSE pattern, don't import engine)
```ts
const verdict = guardrails.evaluate(userPrompt, {});
if (verdict.kind === "short-circuit") {
  await auditLog.append({
    tIso: now, event: "short-circuit", ruleId: verdict.rule,
    rulesetVersion: guardrails.rulesetVersion,
    patternsetVersion: "patternsetVersion" in guardrails
      ? (guardrails as { patternsetVersion: string }).patternsetVersion : undefined,
  });
  // ...return canned escalation; NO finding...
}
```
**Rule:** in recommend.ts the red-flag fires INSIDE runJudgeLoop, so map `outcome.outcome === "short-circuit"` → this exact `auditLog.append({ event:"short-circuit", ruleId: outcome.rule, ... })`. `MedicalGuardrails` exposes `.rulesetVersion` (guardrails.ts:64) and `.patternsetVersion` getter (guardrails.ts:113).

### H. FactStore meds read — engine.ts:365-381 (EXACT pattern from contract assumption)
```ts
let activeMeds: FactRecord[];
if (this.deps?.facts) {
  activeMeds = this.deps.facts.getActiveFacts("medical", "patient", "takes-medication");
} else {
  const dbPath = factsDbPath(projectRoot, "medical");
  try { const facts = new FactStore(dbPath);
    activeMeds = facts.getActiveFacts("medical", "patient", "takes-medication"); facts.close();
  } catch { activeMeds = []; }   // dir not created yet → graceful empty
}
```
**Rule:** open `new FactStore(factsDbPath(projectRoot,"medical"))`, read meds with subject `"patient"`, predicate `"takes-medication"`. Wrap in try/catch → `[]`. Accept an injected `facts?: FactStore` dep (tests pass `:memory:`). **Supplements predicate: see §9 PITFALL — it is NOT `takes-supplement`.**

### I. Finding emission — finding.ts:36-52 + finding-writer.ts:27-33 (REUSE; do not rebuild)
```ts
interface MedicalFinding {
  id; domain:"medical"; title; kind:"action"|"watch"|"risk"|"question";
  urgency:number; severity:number; evidence:string[]; surfacedAt:string /*=now*/;
  dueBy?; tags:string[]; status:"open"|"resolved"|"dismissed"; promotesTo?;
}
findingId(domain, biomarker, ruleKey): string   // deterministic SHA-256[0..16); NEVER includes now
await writeFinding(vaultDir, finding): Promise<string>   // -> <vaultDir>/findings/<id>.md
```
**Rule:** accepted → `kind:"action"`, urgency/severity from `assignUrgencySeverity`, push `confidence:${n}` into `tags[]` (sc-3-6), `surfacedAt: now`, `status:"open"`. no-consensus → `kind:"question"`, `title` containing `"flagged for your review"`, `evidence` = per-lens dissent strings (sc-3-3). `id = findingId("medical", <question/marker>, "recommend-action"|"recommend-question")`. Vault resolve EXACTLY as review-pass.ts:51-52: `config.medical?.vaultDir ?? join(projectRoot, ".bober", "medical", "vault")`.

### J. AuditLog — audit.ts:21-58 + types.ts:65-92
```ts
new AuditLog(projectRoot).append({ tIso: now, event: "answer"|"abstain"|"short-circuit"|"refuse", ruleId?, rulesetVersion? });
// AuditEvent = "consent"|"short-circuit"|"refuse"|"answer"|"abstain"|"ingest"
```
**Rule:** accepted → `event:"answer"`; no-consensus(rejected) → `event:"abstain"`; short-circuit → `event:"short-circuit"`; refuse → `event:"refuse"`. IDs/enums ONLY — NEVER prompt text, recommendation text, or health values (NonGoal #3).

### K. LLM call + JSON mode — providers/types.ts:139-201, 234-240
```ts
interface LLMClient { chat(params: ChatParams): Promise<ChatResponse>; }   // ChatResponse.text holds the string
llm.chat({ model, system, messages:[{role:"user",content}], jsonObjectMode: true });
```
**Rule:** for urgency.ts AND generateCandidate use `{ model, system, messages, jsonObjectMode: true }` (mirrors lenses.ts:216-221). `response.text` is the raw string to parse.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `runJudgeLoop` | `src/medical/recommend/judge-panel.ts:89` | `(input:{question,generateCandidate,lensClients,context,redFlag,maxRounds?,now?}) -> Promise<PanelOutcome>` | The sprint-2 panel loop — IMPORT, never re-implement |
| `buildMedicalInferenceClient` | `src/medical/inference.ts:31` | `(config, egress, factory?) -> {client,model}` | Fail-closed local-vs-cloud model resolver (sc-3-5 seam) |
| `EgressGuard.fromConfig` / `.isAllowed` | `src/medical/egress.ts:25,35` | `(config)->EgressGuard` / `(axis)->boolean` | cloud-inference egress gate |
| `tierPolicy.resolveTier` | `src/fleet/tier-policy.ts:75` | `(tier?)->TieredRoleBlock|undefined` | tier→provider block (cloud ON only) |
| `createClient` / `ClientFactory` | `src/providers/factory.ts:192`, `inference.ts:17` | `(provider?,endpoint?,providerConfig?,model?,role?)->LLMClient` | Build a tier cloud client (inject as factory) |
| `MedicalGuardrails` (.evaluate/.rulesetVersion/.patternsetVersion) | `src/medical/guardrails.ts:63,84,113` | `new MedicalGuardrails()` impl `GuardrailSet` | Red-flag/refusal guard to inject as `redFlag` |
| `writeFinding` / `writeDashboard` | `src/medical/analysis/finding-writer.ts:27,62` | `(vaultDir, finding)->Promise<string>` | Emit Finding markdown — REUSE |
| `findingId` | `src/medical/analysis/finding.ts:65` | `(domain,biomarker,ruleKey)->string` | Deterministic finding id |
| `MedicalFinding` (type) | `src/medical/analysis/finding.ts:36` | interface | The finding fields to populate |
| `AuditLog.append` | `src/medical/audit.ts:44` | `(AuditEntry)->Promise<void>` | IDs/enums-only audit |
| `FactStore` / `getActiveFacts` | `src/state/facts.ts:136,222` | `getActiveFacts(scope,subject?,predicate?)->FactRecord[]` | Read meds/supplements |
| `factsDbPath` | `src/state/facts.ts:77` | `(projectRoot,namespace?)->string` | facts.db path |
| `readProfile` / `Profile` / `ProfileSchema` | `src/medical/profile.ts:231,26,16` | `(vaultDir, deps?)->Promise<Profile>` | conditions/allergies/goals (SOPS-encrypted) |
| `validateLensVerdict` / `validateGroundingVerdict` | `lenses.ts:65`, `grounding-critic.ts:40` | `(raw)->{ok,...}` | 4-tier never-throwing JSON parse to MIRROR in urgency.ts |
| `loadConfig` | `src/config/loader.ts:142` | `(projectRoot)->Promise<BoberConfig>` | CLI config load |
| `ensureDir` / `findProjectRoot` | `src/utils/fs.ts:45,58` | `(path)->Promise<void>` / `()->Promise<string|null>` | dirs + root |

Utilities reviewed: `utils/`, `state/`, `medical/`, `medical/recommend/`, `medical/analysis/`, `fleet/`, `providers/`, `config/`.

---

## 4. Prior Sprint Output

### Sprint 1 (307e5e7): src/medical/analysis/
**Created:** `finding.ts` (`MedicalFinding`, `findingId`, `serializeFindingToMarkdown`), `finding-writer.ts` (`writeFinding`/`writeDashboard`), `review-pass.ts` (`runProactiveReview` + vault resolve `config.medical?.vaultDir ?? <root>/.bober/medical/vault`), and `config.medical.vaultDir` (schema.ts:400).
**Connection:** REUSE `writeFinding`/`MedicalFinding`/`findingId` to emit. Resolve vaultDir IDENTICALLY (review-pass.ts:51-52). NOTE: sprint-1 urgency/severity are deterministic rule tiers; **sprint-3's are LLM-assigned** (urgency.ts) — by design outside ADR-3 numerics.

### Sprint 2 (fb467c6): src/medical/recommend/{types,lenses,judge-panel}.ts
**Created:** `runJudgeLoop` (injected deps), `LensClients`/`LensSpec`/`LensVerdict`/`PanelOutcome`, the four lens system-prompt builders + never-throwing `validateLensVerdict`.
**Connection:** IMPORT `runJudgeLoop` and the `LensClients` type. Sprint 3 supplies the four REAL `{client,model}` specs + `generateCandidate` + `redFlag` + `context` string.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` read for this sprint. Code-enforced invariants observed in-tree: clock read ONLY at CLI boundary (`new Date().toISOString()` then injected as `now` — finding.ts:5-9, audit.ts:30-32, medical.ts:360); `.action()` MUST NOT throw (set `process.exitCode = 1`); audit entries are IDs/enums ONLY (audit.ts:14-19, NonGoal #3); fail-closed egress (ADR-6, egress.ts:1).

### Architecture Decisions
ADR-3 (deterministic numerics, `numerics.ts`): urgency/severity/confidence are INTERPRETATION (LLM), deliberately OUTSIDE this boundary (contract assumption 3). ADR-6 (zero-egress default): cloud-inference must be opt-in. ADR-7 (meds in FactStore, never HealthDataStore — engine.ts:366).

### Other Docs
Contract `generatorNotes`/`evaluatorNotes` in `.bober/contracts/sprint-spec-20260628-medical-analysis-3.json` are authoritative for the file plan.

---

## 6. Testing Patterns

### Unit Test Pattern — fake LLM clients (the canonical sprint-2 fixtures to copy)
**Source:** `src/medical/recommend/judge-panel.test.ts:17-97`
```ts
class ScriptedClient implements LLMClient {
  readonly calls: ChatParams[] = []; private idx = 0;
  constructor(private readonly responses: string[]) {}
  async chat(params: ChatParams): Promise<ChatResponse> {
    this.calls.push(params);
    const text = this.responses[Math.min(this.idx, this.responses.length - 1)] ?? "";
    this.idx += 1;
    return { text, toolCalls: [], stopReason: "end", usage: { inputTokens: 3, outputTokens: 5 } };
  }
}
const APPROVE = '{"verdict":"approve","feedback":""}';
function makeAllApproveLensClients(): LensClients {
  return { evidenceGrader:{client:makeApproveClient(),model:"test-model"}, contraindicationChecker:{...}, conservativeClinician:{...}, optimizationLens:{...} };
}
const allowGuard: GuardrailSet = { rulesetVersion:"test-1", evaluate: () => ({ kind:"allow" }) };
const shortCircuitGuard: GuardrailSet = { rulesetVersion:"test-1", evaluate: () => ({ kind:"short-circuit", rule:"cardiac", cannedResponse:"Call 911 immediately." }) };
```
**Runner:** vitest. **Assertion:** `expect`. **Mock:** `vi.fn` + hand-rolled `implements LLMClient` (NO `vi.mock`). **File naming:** `*.test.ts` collocated.

### Fail-closed factory spy (sc-3-5) — MIRROR inference.test.ts:18-56 EXACTLY
**Source:** `src/medical/inference.test.ts:18-56`
```ts
function makeFactorySpy() {
  return vi.fn((_p?:string|null,_e?:string|null,_pc?:unknown,_m?:string): LLMClient => ({ chat: vi.fn() }));
}
const spy = makeFactorySpy();
// ... build recommendation with cloud OFF, injecting `spy` as the ClientFactory dep ...
expect(spy).toHaveBeenCalledWith("openai-compat", "http://localhost:11434/v1", undefined, "llama3");
expect(spy).not.toHaveBeenCalledWith("anthropic", expect.anything(), expect.anything(), expect.anything());
```
**Rule:** `recommend.ts` MUST accept `deps.clientFactory?: ClientFactory` and thread it into BOTH `buildMedicalInferenceClient(config, egress, factory)` and any tier `createClient`. sc-3-5 then asserts the spy was NEVER called with a cloud provider (anthropic / deepseek / grok endpoints).

### Temp vault + FactStore + assert written frontmatter (sc-3-2/3/6)
**Source:** `src/medical/analysis/review-pass.test.ts:1-119`
```ts
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
beforeEach(async () => { tmpRoot = await mkdtemp(join(tmpdir(), "bober-recommend-")); });
afterEach(async () => { await rm(tmpRoot, { recursive: true, force: true }); });
const config = {} as BoberConfig;                 // or { medical:{ vaultDir } } as BoberConfig
const facts = new FactStore(":memory:");          // inject for meds/supplements
// after generateRecommendation: read <vaultDir>/findings/*.md and assert:
//  - kind: action  + NO "consult a licensed healthcare professional" substring (sc-3-2)
//  - urgency/severity integers 1..5 (sc-3-6); confidence in frontmatter tags
//  - kind: question + title includes "flagged for your review" + dissent text (sc-3-3)
```
**Rule:** assert via `readFile(notePath,"utf-8")` then string `.toContain` / regex on the YAML frontmatter and body. The body emitted by `serializeFindingToMarkdown` (finding.ts:104-110) renders `title`, kind/urgency/severity, and `evidence[]` bullets — put the recommendation text in the title/evidence so sc-3-2 finds it.

### Inject all deps so tests avoid network
Define `RecommendDeps` with optional: `lensClients`, `generateCandidate`, `redFlag`, `assignUrgency`, `writeFindingFn`, `facts`, `egress`, `clientFactory`, `auditLog`, `profileCipher`. Production CLI passes none.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/commands/medical.ts` | adds a subcommand | low | Additive `.command("recommend")`; existing review/whoop/import/profile actions untouched |
| `src/cli/index.ts` | registers medical command | low | No signature change to `medicalCommand(...)` |
| `src/medical/recommend/judge-panel.ts` + `types.ts` + `lenses.ts` | imported read-only | none | DO NOT edit — import only |
| `src/medical/analysis/finding*.ts` | imported read-only | none | Reuse writeFinding/MedicalFinding/findingId unchanged |
| `src/medical/inference.ts`, `egress.ts`, `guardrails.ts`, `audit.ts` | imported read-only | none | No edits |
| `src/medical/engine.ts` | NOT imported | none | **NO-TOUCH** — `git diff` must show zero changes (evaluatorNotes) |

### Existing Tests That Must Still Pass
- `src/medical/recommend/judge-panel.test.ts` — covers runJudgeLoop; sprint 3 only imports it, so MUST stay green.
- `src/medical/recommend/lenses.test.ts` — lens parsing; unaffected.
- `src/medical/inference.test.ts` — buildMedicalInferenceClient fail-closed; the seam sprint 3 reuses; MUST stay green.
- `src/medical/analysis/review-pass.test.ts`, `finding.test.ts`, `finding-writer.test.ts` — finding emission; MUST stay green.
- `src/medical/engine.test.ts` — MedicalSopEngine reactive path; MUST be byte-identical (stopCondition + evaluatorNotes `git diff`).
- `src/medical/guardrails.test.ts`, `audit.test.ts` — guard + audit; unaffected.

### Features That Could Be Affected
- **Reactive `bober chat medical` / MedicalSopEngine** — shares `guardrails.ts`, `inference.ts`, `audit.ts`, `egress.ts`. Verify those modules are read-only; recommend.ts is a NEW proactive surface (NonGoal #1).
- **Sprint 4 (cross-marker dig-deeper) / Sprint 5 (online research)** — will build on these recommend modules; keep deps injectable.

### Recommended Regression Checks
1. `npm run build` (tsc) — zero type errors with the new path (sc-3-1).
2. `npx vitest run src/medical/recommend src/medical/analysis src/medical/inference.test.ts` — new + reused suites green.
3. `npx vitest run src/medical/engine.test.ts` — unchanged & green.
4. `git diff --stat src/medical/engine.ts` — MUST be empty.
5. `node dist/index.js medical recommend --goal 'optimize energy' "what should I do about my high LDL"` — prints accepted/flagged/escalated, exits 0 (sc-3-7).

---

## 8. Implementation Sequence (dependency-ordered)

1. **src/medical/recommend/context.ts** — `assembleRecommendationContext`. Open `FactStore(factsDbPath(root,"medical"))` (try/catch→[]); meds = `getActiveFacts("medical","patient","takes-medication")` (engine.ts:370); supplements = `getActiveFacts("medical", undefined, "dose")` mapped `r => r.subject` (see §9 PITFALL); profile via `readProfile(vaultDir, deps)` wrapped try/catch → conditions/allergies/goals = `[]` when absent. Return `{ meds, supplements, conditions, allergies, goal }` + a `toContextString()` helper.
   - Verify: a `:memory:` FactStore test returns seeded meds; absent dir → `{ meds:[], ... }` (no throw).
2. **src/medical/recommend/urgency.ts** — `assignUrgencySeverity(llm, model, candidate, context)`: one `llm.chat({model,system,messages,jsonObjectMode:true})`; never-throwing validator mirroring `validateLensVerdict` (lenses.ts:65-113) with Zod `{ urgency:int1..5, severity:int1..5, confidence:number }`; clamp + conservative default on parse failure.
   - Verify: a ScriptedClient returning `{"urgency":4,"severity":3,"confidence":4}` yields those; garbage input → clamped safe default, no throw.
3. **src/medical/recommend/recommend.ts** — `generateRecommendation(root, config, {question, goal?, now}, deps?)`: build `EgressGuard.fromConfig` (or `deps.egress`); IF `egress.isAllowed("cloud-inference")` map four lenses to tier blocks via `factory(block.provider, block.endpoint??undefined, undefined, block.model)`, ELSE all four + generator via `buildMedicalInferenceClient(config, egress, factory)`; assemble `context` string; build `generateCandidate` = LLM call; `runJudgeLoop({question, generateCandidate, lensClients, context, redFlag: deps.redFlag ?? new MedicalGuardrails(), now})`; switch outcome → emit Finding + audit.
   - Verify: sc-3-2 accepted (action, no hedging), sc-3-3 no-consensus (question + dissent), sc-3-4 red-flag (no finding + short-circuit audit), sc-3-5 cloud-OFF factory spy never called with cloud, sc-3-6 urgency/severity 1..5.
4. **src/cli/commands/medical.ts** — add `.command("recommend <question>").option("--goal <g>")` mirroring lines 349-373; clock read here; try/catch→`process.exitCode=1`.
   - Verify: `medical recommend "..."` prints outcome kind and exits 0.
5. **Collocate tests** (context.test.ts, urgency.test.ts, recommend.test.ts) — copy fixtures from judge-panel.test.ts + inference.test.ts + review-pass.test.ts.
6. **Run full verification** — `npm run build` && `npx vitest run` && `git diff --stat src/medical/engine.ts` (empty).

---

## 9. Pitfalls & Warnings

- **PITFALL — supplements predicate is NOT `takes-supplement`.** The contract/generatorNotes say `'takes-supplement'`, but supplements are persisted by `supplementToFact` (supplements.ts:106-121) as `scope:"medical", subject:<supplement name>, predicate:"dose"`. A `getActiveFacts("medical","patient","takes-supplement")` will ALWAYS return `[]`. To actually surface supplements, read `getActiveFacts("medical", undefined, "dose")` and map `record.subject` → supplement name (and `record.value` → dose). Meds ARE `subject:"patient", predicate:"takes-medication"` (correct in the contract). Degrading supplements to `[]` still passes all required SCs, but reading by `"dose"` is the correct behavior.
- **HIGHEST RISK (sc-3-5) — fail-closed model selection.** With `egress.isAllowed("cloud-inference") === false`, NO cloud client may be constructed for ANY lens or the generator. Gate the ENTIRE tier branch behind `if (egress.isAllowed("cloud-inference"))`. Thread ONE injected `ClientFactory` through both `buildMedicalInferenceClient` and the tier `createClient` so the spy proves it. Do NOT call `createClient` with `"anthropic"`/`"deepseek"`/`"grok"`/`api.x.ai` when the axis is off.
- **HIGHEST RISK (sc-3-2) — no refer-out hedging in the action body.** The accepted Finding body must state the recommendation DIRECTLY. Do NOT append any disclaimer/"consult a licensed healthcare professional"/"see your doctor" text to a `kind:"action"` finding. Put the candidate recommendation into the `title`/`evidence[]`. (The conservative-clinician lens may internally reward escalation, but that is the lens's verdict, not your finding body.)
- **engine.ts is NO-TOUCH.** Reuse its PATTERNS (gate ordering, audit shape, FactStore open) by copying, not by importing or editing. `git diff src/medical/engine.ts` must be empty (evaluatorNotes).
- **runJudgeLoop is IMPORTED, not re-implemented** (NonGoal #5). Do not duplicate reconcile/veto/round logic.
- **`context` passed to runJudgeLoop is a STRING** (judge-panel.ts:92, 140-141). Serialize your context object first; passing an object is a type error.
- **Clock discipline:** read `new Date().toISOString()` ONLY in the CLI `.action()`; pass `now` down. `findingId` and audit filenames must derive from the injected `now`, never the wall clock (finding.ts:5-9, audit.ts:30-32).
- **`readProfile` throws when SOPS is unavailable** (profile.ts:237-241) AND on ENOENT. Wrap in try/catch and default conditions/allergies/goals to `[]` (contract: "degraded but functional"). Tests should inject a reversible `ProfileCipher` fake or skip the profile (catch→[]).
- **Vault dir for findings vs. profile.yaml:** findings resolve to `config.medical?.vaultDir ?? <root>/.bober/medical/vault` (review-pass.ts:51); `profile.yaml` lives at `<root>/.bober/medical` (profile.ts:271). Do not conflate — `readProfile(join(root,".bober","medical"))`.
- **Audit log carries enums/IDs only** (NonGoal #3). Never write question/recommendation/health text into `AuditEntry`.
- **FactStore lifecycle:** if you open a `FactStore` you must `.close()` it (facts.ts:303); for injected `:memory:` stores in tests, the caller owns the lifecycle (mirror review-pass.ts:56-98 `weOpened` guard).
