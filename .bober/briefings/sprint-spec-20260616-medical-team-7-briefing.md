# Sprint Briefing: MedlinePlus grounded retrieval + cited synthesis (opt-in)

**Contract:** sprint-spec-20260616-medical-team-7
**Generated:** 2026-06-16T00:00:00Z

> FINAL buildable sprint. This is the ONLY networked slice of the Medical Team. Everything is opt-in
> behind the `literature-retrieval` egress axis (default FALSE). Three hard invariants govern the whole
> sprint, repeated in every section below because a violation of any one fails the contract:
> 1. **ONE network file.** The real `fetch` lives ONLY in `src/medical/retrieval/medline-source.ts`.
> 2. **assertAllowed BEFORE fetch.** Runtime guard at the call site, defense-in-depth over ESLint.
> 3. **Fail-closed.** Source error => abstain. Unsupported claim => abstain. NEVER emit an uncited clinical claim.

---

## 0. The Three Hard Constraints (read first)

### 0a. Single-network-file constraint — EXACT PATH

The ESLint exception (added S6, confirmed at `eslint.config.js:99-106`) turns off `no-restricted-imports`
and `no-restricted-globals` for EXACTLY ONE file:

```js
// eslint.config.js:99-106
{
  // ADR-6 single exception: the ONE designated retrieval network file. S7 puts the real MedlinePlus call here.
  files: ["src/medical/retrieval/medline-source.ts"],
  rules: {
    "no-restricted-imports": "off",
    "no-restricted-globals": "off",
  },
},
```

The broader medical rule at `eslint.config.js:70-98` forbids the `fetch` global and any `http/https/net/tls/undici/got/axios/node-fetch` import in every other `src/medical/**/*.ts` file. The exact exempt path is:

```
src/medical/retrieval/medline-source.ts
```

**RULE:** Put `fetch` (or `undici`) usage NOWHERE except `src/medical/retrieval/medline-source.ts`. In `literature.ts`, `engine.ts`, and ALL test files, do NOT reference `fetch`/`undici`/`http`. `sc-7-3` is verified by `grep` showing the only network usage in `src/medical` is in this one file (evaluatorNotes).

### 0b. assertAllowed BEFORE fetch — runtime defense-in-depth

The S6 `EgressGuard.assertAllowed` throws when the axis is off (`src/medical/egress.ts:41-45`):

```ts
// src/medical/egress.ts:41-45
assertAllowed(axis: EgressAxis): void {
  if (!this.isAllowed(axis)) {
    throw new Error(`Egress axis '${axis}' not enabled`);
  }
}
```

The real network call in `medline-source.ts` MUST call `egress.assertAllowed("literature-retrieval")` BEFORE any `fetch` attempt. This is intentionally redundant with `LiteratureRetriever`'s `isAllowed` short-circuit (`literature.ts:30`) — it is the runtime guard that backs the static ESLint boundary. To do this, `MedlineSource` needs access to the `EgressGuard` (pass it into the constructor or into the query method — see Section 1).

### 0c. Fail-closed — NEVER fail-open

- Source unreachable / throws / timeout => `retrieve` returns `{ kind: "abstain", reason: "source-error" }` (`sc-7-7`).
- Empty passages => `{ kind: "abstain", reason: "no-passages" }`.
- LLM answer not supported by a passage, or empty => `synthesize` returns `abstained: true`, `citations: []`, and a "cannot ground an answer" body. NO clinical assertion.
- Local model unavailable => abstain + "model unavailable" footer. Do NOT auto-fallback to a cloud provider (`sc-7-8`).
- Every non-abstained clinical answer carries `citations.length >= 1` (`sc-7-6`).

---

## 1. Target Files

### src/medical/retrieval/medline-source.ts (modify — THE network file)

**Current state (full file — it is a stub, lines 1-31):**
```ts
// src/medical/retrieval/medline-source.ts:1-31
/** MedlineSource — the ONLY medical file allowed network imports (ADR-6 exception). S7 adds the real call. */
// NO network import yet — Sprint 7 adds the MedlinePlus fetch here under EgressGuard.assertAllowed.

export type RetrievalOutcome =
  | { kind: "disabled" }
  | { kind: "abstain"; reason: string }
  | { kind: "grounded"; passages: string[] }; // S7 only   <-- consider widening to Passage[] (see note)

export class MedlineSource {
  /** Stub this sprint: no network. Returns abstain. The live source call lands in S7. */
  async fetchPassages(_query: string): Promise<RetrievalOutcome> {
    return { kind: "abstain", reason: "literature source not implemented (Sprint 7)" };
  }
}
```

**What to change:**
- Add a structured `Passage` type. The existing `grounded.passages` is `string[]`. The contract/generatorNotes call for `Passage[] { title, url, text, source: 'medlineplus' }` so citations can reference source URLs/titles. **Widen the union additively** — either change `passages: string[]` to `passages: Passage[]` (preferred; only `composeBody` in `engine.ts:137-179` and tests read it), exporting `Passage` from this file. Verify no other consumer relies on the `string[]` shape (only `engine.ts` imports `RetrievalOutcome` — see "Imported by").
- `MedlineSource` needs the `EgressGuard` AND an injectable transport so tests never hit the network. Recommended shape:
  ```ts
  export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;
  export class MedlineSource {
    constructor(
      private readonly egress: EgressGuard,
      private readonly fetchImpl: FetchLike = fetch,   // global fetch is allowed ONLY in this file
    ) {}
    async fetchPassages(query: string): Promise<RetrievalOutcome> {
      this.egress.assertAllowed("literature-retrieval");  // throw if axis off (0b)
      try {
        const res = await this.fetchImpl(buildMedlineUrl(query));
        if (!res.ok) return { kind: "abstain", reason: "source-error" };
        const json = await res.json();
        const passages = parseMedline(json);            // map to Passage[]
        return passages.length ? { kind: "grounded", passages } : { kind: "abstain", reason: "no-passages" };
      } catch {
        return { kind: "abstain", reason: "source-error" };  // NEVER fabricate (0c)
      }
    }
  }
  ```
  `Response` and `fetch` globals are declared in `eslint.config.js:23-24` and exempted for this file at `eslint.config.js:99-106` — they typecheck and lint here.
- Import `EgressGuard` as a type-or-value from `../egress.js` (it is a runtime class; `assertAllowed` is called, so import the value: `import { EgressGuard } from "../egress.js"`). Use `import type` for `Response`-free helper types only.

**Imports this file uses:** `EgressGuard` from `../egress.js`; global `fetch`/`Response` (exempt here only).
**Imported by:** `src/medical/retrieval/literature.ts:3` (`MedlineSource`, `RetrievalOutcome`); `src/medical/engine.ts:36` (`type RetrievalOutcome`); `src/medical/engine.test.ts` (`MedlineSource`).
**Test file:** `src/medical/retrieval/medline-source.test.ts` — does NOT exist (create it).

---

### src/medical/retrieval/literature.ts (modify — orchestration + synthesize)

**Current full file (lines 13-35):**
```ts
// src/medical/retrieval/literature.ts:13-35
export class LiteratureRetriever {
  constructor(
    private readonly egress: EgressGuard,
    private readonly source = new MedlineSource(),   // <-- MedlineSource ctor changes (now needs egress); update default
  ) {}

  async retrieve(query: string): Promise<RetrievalOutcome> {
    if (!this.egress.isAllowed("literature-retrieval")) {
      return { kind: "disabled" };                   // sync short-circuit — KEEP (sc-7-5, zero-egress proof)
    }
    return this.source.fetchPassages(query);
  }
}
```

**What to change:**
- Keep the `isAllowed` short-circuit EXACTLY as-is (`sc-7-5` OFF path + zero-egress proof at `engine.test.ts:666-671`).
- The default `source = new MedlineSource()` must now pass the egress guard: `source = new MedlineSource(egress)`. Because of TS field-initialization order, construct it in the constructor body or default to `new MedlineSource(egress)` — verify the param default can reference `egress` (it can, since `egress` is the first param). The `engine.test.ts:628` injection `new LiteratureRetriever(egress, sourceStub)` still works because `sourceStub` is passed explicitly.
- `retrieve` already returns `disabled | abstain | grounded` once `MedlineSource` is real. The generatorNotes wrapping (try/catch -> abstain) lives in `MedlineSource.fetchPassages` per Section 1; `retrieve` just delegates. Optionally also wrap `retrieve`'s delegate call in try/catch returning `{kind:'abstain',reason:'source-error'}` as belt-and-braces (harmless, satisfies sc-7-7 even if MedlineSource is replaced by a throwing fake).
- **Add `synthesize`** here (generatorNotes: "literature.ts ... + synthesize"). Signature suggestion:
  ```ts
  export async function synthesize(
    query: string,
    outcome: RetrievalOutcome,
    llm: LLMClient,
    footer: string,
  ): Promise<MedicalAnswer> { ... }
  ```
  - `disabled`/`abstain` => return abstained `MedicalAnswer` (`abstained:true`, `citations:[]`, body = "cannot ground an answer" message, `disclaimerFooter: footer`, `shortCircuit:false`).
  - `grounded` => build a system prompt pinning the model to the passages ("answer ONLY from these passages; if unsupported, reply exactly ABSTAIN"); call `llm.chat({ model, system, messages:[{role:'user',content:query}], maxTokens })` ONCE; inspect `response.text`. If empty / equals ABSTAIN / unsupported => abstained. Else => `abstained:false`, attach `citations` derived from the passages (>= 1).
  - Wrap the `llm.chat` call so a thrown error (e.g. Ollama unreachable) => abstained + "model unavailable" footer, NO cloud fallback (`sc-7-8`).
- Import `LLMClient` as a **type** from `../../providers/types.js` (consistent-type-imports is errored — see `eslint.config.js:39`). Import `MedicalAnswer`, `Citation`, `Passage` types.

**Imports this file uses:** `type EgressGuard` from `../egress.js:2`; `MedlineSource, type RetrievalOutcome` from `./medline-source.js:3`; NEW: `type LLMClient` from `../../providers/types.js`, `type MedicalAnswer`/`Citation` from `../types.js`.
**Imported by:** `src/medical/engine.ts:29` (`LiteratureRetriever`); `src/medical/engine.test.ts` (`LiteratureRetriever`).
**Test file:** `src/medical/retrieval/literature.test.ts` — does NOT exist (create it).

---

### src/medical/engine.ts (modify — wire synthesize into the retrieval branch)

**Current retrieval branch (lines 344-363):**
```ts
// src/medical/engine.ts:344-363
// ── GATE 3 + (5) Literature egress gate ───────────────────────────
const egress = this.deps?.egress ?? EgressGuard.fromConfig(config);
const literature = this.deps?.literature ?? new LiteratureRetriever(egress);
const outcome = await literature.retrieve(userPrompt); // {disabled} sync when axis off → NO network

// ── (6)+(7)+(8) Compose answer + audit + return ───────────────────
const hasNumericAnswer = numericResult !== null && numericResult.sampleCount > 0;
const abstained = outcome.kind !== "grounded" && !hasNumericAnswer;
const answer: MedicalAnswer = {
  body: composeBody(numericResult, activeMeds, outcome),
  abstained,
  citations: [],                          // <-- S7: grounded path must attach citations
  disclaimerFooter: footer,
  shortCircuit: false,
};
await auditLog.append({ tIso: now, event: abstained ? "abstain" : "answer", rulesetVersion });
```

**What to change (ADDITIVE — preserve every S1-S6 behavior):**
- When `outcome.kind === "grounded"`: call `synthesize(userPrompt, outcome, llmClient, footer)` to produce the cited answer, and use ITS `abstained`/`citations`/`body`. The numeric/medication path (composeBody) stays for the non-grounded branches.
- Obtain the `LLMClient` for synthesize: prefer the injected `this.deps?.llmClient` (the S3 seam, `engine.ts:53`); ONLY when undefined AND the grounded branch is reached, construct the LOCAL Ollama client via the provider factory. Do NOT construct any client unless a grounded synthesis actually happens (so the disabled/numeric paths still make zero LLM and zero provider construction — `sc-7-8`, `engine.test.ts:595` asserts `llmSpy.chat` not called on numeric path).
- The existing tests assert `llmClient` is NEVER called on red-flag/numeric/disabled paths (`engine.test.ts:374,595,661`). KEEP that: only call `llm.chat` inside `synthesize`'s grounded branch.
- `abstained` recompute: when grounded synthesis abstains, the audit event must be `"abstain"`; when it produces a cited answer, `"answer"`. Map from the synthesized `MedicalAnswer.abstained`.

**Imports this file uses (existing):** see `engine.ts:20-37` — `LiteratureRetriever` (`:29`), `type RetrievalOutcome` (`:36`), `type LLMClient` (`:35`), `EgressGuard` (`:28`). NEW: `synthesize` from `./retrieval/literature.js`; `createClient` from `../providers/factory.js` (ONLY for the local Ollama default — see Section 4).
**Imported by:** `src/orchestrator/workflow/selector.ts:126` (`new MedicalSopEngine()` zero-arg — MUST stay zero-arg constructable; `engine.ts:193` keeps `deps?` optional).
**Test file:** `src/medical/engine.test.ts` — EXISTS (612-687 already drive the disabled + axis-on paths; extend, do not rewrite).

---

### src/medical/types.ts (modify — additive citation/passage types)

**Current placeholder (lines 32-45):**
```ts
// src/medical/types.ts:32-45
/** Placeholder for literature citation shape. Real fields land in S7. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Citation {
  /* placeholder for S7 */
}

export interface MedicalAnswer {
  body: string;
  abstained: boolean;
  citations: Citation[];
  disclaimerFooter: string;
  shortCircuit: boolean;
}
```

**What to change:** Fill `Citation` with real fields (additive — `MedicalAnswer.citations: Citation[]` already exists, so populating fields does not break the shape). Remove the `eslint-disable` line once the interface has members. Suggested:
```ts
export interface Citation {
  title: string;
  url: string;
  source: "medlineplus";
}
```
A `Passage` type can also live here (so both `literature.ts` and `medline-source.ts` import it) OR in `medline-source.ts` (where `RetrievalOutcome` lives). Pick one home and import consistently. Keep `MedicalAnswer` field names unchanged — `engine.ts` and every S2-S6 test read `body/abstained/citations/disclaimerFooter/shortCircuit`.

**Imported by:** `engine.ts:34`, every `src/medical/*.test.ts`, `team.ts`. Changing field CONTENTS of `Citation` is safe; renaming `MedicalAnswer` fields is NOT.
**Test file:** types-only; no dedicated test.

---

### src/medical/retrieval/medline-source.test.ts (create)
### src/medical/retrieval/literature.test.ts (create)
### src/medical/retrieval/__fixtures__/medlineplus-sample.json (create)

**Directory pattern:** tests are collocated `*.test.ts` next to source (principles.md "Tests are collocated with source"). Fixtures go under a `__fixtures__/` sibling dir (precedent: `src/fleet/__fixtures__/`, `src/graph/incidents.test.ts` uses fixtures). **Most similar existing test for the LLM-spy pattern:** `src/medical/engine.test.ts`. **Most similar for fixture loading:** see Section 6.

---

## 2. Patterns to Follow

### Fake LLMClient injection (THE synthesize test seam)
**Source:** `src/medical/engine.test.ts:128, 352, 556`
```ts
// src/medical/engine.test.ts:352
const llmSpy: LLMClient = { chat: vi.fn() };
```
For a SUPPORTED-answer test, give it a resolved value:
```ts
const llm: LLMClient = {
  chat: vi.fn().mockResolvedValue({
    text: "Metformin commonly causes gastrointestinal side effects.",
    toolCalls: [], stopReason: "end", usage: { inputTokens: 0, outputTokens: 0 },
  }),
};
```
For an UNSUPPORTED/abstain test, return empty text or `"ABSTAIN"`. For "model unavailable", `chat: vi.fn().mockRejectedValue(new Error("ECONNREFUSED"))`.
**Rule:** synthesize takes the `LLMClient` as a parameter / `deps.llmClient`; tests pass `{ chat: vi.fn() }`. NEVER construct a real provider in tests.

### Injected source/transport (THE retrieval test seam — no live network)
**Source:** `src/medical/engine.test.ts:623-628`
```ts
// src/medical/engine.test.ts:623-628
const sourceStub = new MedlineSource();
const sourceSpy = vi.spyOn(sourceStub, "fetchPassages");
const egress = new EgressGuard(false, false);
const literature = new LiteratureRetriever(egress, sourceStub);
```
**Rule:** Tests inject a fake `MedlineSource` (or a fake `fetchImpl`/`FetchLike`) so CI never reaches MedlinePlus. For `medline-source.test.ts`, pass a fake `fetchImpl` returning `new Response(JSON.stringify(fixture), {status:200})`; for the throw case pass `() => { throw new Error("network down") }` or a fake returning `{ ok:false, status:503 }`.

### LLMClient interface — the ONLY method
**Source:** `src/providers/types.ts:216-222`
```ts
// src/providers/types.ts:216-222
export interface LLMClient {
  chat(params: ChatParams): Promise<ChatResponse>;
}
```
`ChatParams` (`types.ts:139-184`) requires `{ model, system, messages }`; `ChatResponse` (`types.ts:194-206`) returns `{ text, toolCalls, stopReason, usage }`. synthesize reads `response.text`.
**Rule:** synthesize makes ONE `llm.chat(...)` call and parses `response.text`. Build `messages: [{ role: "user", content: query }]` (a `TextMessage`, `types.ts:96-100`); put the "answer only from passages, else ABSTAIN" instruction in `system`.

### EgressGuard construction in production
**Source:** `src/medical/engine.ts:345`, `src/medical/egress.ts:24-30`
```ts
// engine.ts:345
const egress = this.deps?.egress ?? EgressGuard.fromConfig(config);
```
**Rule:** Reuse this exact pattern; never invent a new egress decision. `EgressGuard.fromConfig` reads `config.medical.egress.literatureRetrieval` (`egress.ts:24-30`, schema `schema.ts:374-383`), default false.

### Section comments + type imports
**Source:** principles.md ("Section comments", "Use `type` imports"); `eslint.config.js:39` (`consistent-type-imports: error`).
**Rule:** Use `// ── Section ───` headers. Import all types with `import type`. Prefix any unused param with `_` (`eslint.config.js:34-37`).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---|---|---|---|
| `EgressGuard.assertAllowed` | `src/medical/egress.ts:41` | `(axis: EgressAxis): void` | Throws if axis off — call BEFORE fetch in medline-source.ts |
| `EgressGuard.isAllowed` | `src/medical/egress.ts:33` | `(axis): boolean` | Non-throwing check — used for the sync short-circuit in literature.ts:30 |
| `EgressGuard.fromConfig` | `src/medical/egress.ts:24` | `(config: BoberConfig): EgressGuard` | Build guard from config; reuse in engine.ts (already used at :345) |
| `createClient` | `src/providers/factory.ts:172` | `(provider?, endpoint?, providerConfig?, model?, role?): LLMClient` | Construct the local Ollama LLMClient (openai-compat path) for synthesize default |
| `DisclaimerComposer.footer` | `src/medical/disclaimer.ts:23` | `(): string` | The wellness footer string for every MedicalAnswer (incl. abstained) |
| `LiteratureRetriever.retrieve` | `src/medical/retrieval/literature.ts:28` | `(query): Promise<RetrievalOutcome>` | The dispatcher (extend, do not duplicate) |
| `MedlineSource.fetchPassages` | `src/medical/retrieval/medline-source.ts:28` | `(query): Promise<RetrievalOutcome>` | The single network method (flesh out) |
| `createDefaultConfig` | `src/config/defaults.ts` (used `engine.test.ts:345`) | `(name, mode): BoberConfig` | Build a test config |

**Utilities reviewed:** `src/utils/` (fs.ts/git.ts/logger.ts — none HTTP/medical-relevant), `src/providers/` (factory + types ARE relevant, above), `src/medical/*` (all relevant, above). There is NO existing generic HTTP/fetch wrapper util — the network call is bespoke to medline-source.ts by design (ADR-6). Do NOT add a shared fetch util in `src/utils/` (it would escape the medical ESLint glob).

---

## 4. The LLMClient synthesize seam — EXACTLY how to obtain the client

**Test path (preferred for all unit tests):** inject `deps.llmClient` — the S3 seam at `engine.ts:53`. synthesize receives the `LLMClient` as a parameter. Tests pass `{ chat: vi.fn().mockResolvedValue(...) }`. NO provider is constructed.

**Production default path (local Ollama, no cloud):** when `deps.llmClient` is undefined and the grounded branch is reached, construct the local client via the factory (`src/providers/factory.ts:172`). The local Ollama route is the `openai-compat` provider with an Ollama endpoint:
```ts
// factory.ts:244-260 — openai-compat path; Ollama uses apiKey "not-needed"
createClient("openai-compat", "http://localhost:11434/v1", undefined, "llama3");
// OR via the "ollama/" model shorthand (factory.ts:208-210 resolveProviderModel):
createClient(undefined, undefined, undefined, "ollama/llama3");
```
`OpenAICompatAdapter` (`src/providers/openai-compat.ts:31-44`) defaults the apiKey to `"not-needed"` for Ollama. **Do NOT call `createClient("anthropic"...)` or any cloud provider in the literature path** — `sc-7-8` asserts no cloud provider is constructed and `cloud-inference` stays false. **Do NOT auto-fallback to cloud** when the local model throws — abstain with a "model unavailable" footer instead.

**Axis independence (sc-7-8):** enabling `literature-retrieval` only affects the literature path. `EgressGuard` keeps the two axes independent (`egress.ts:33-35`, tested at `egress.test.ts:25-28`). The literature path must never touch `cloud-inference`.

---

## 5. The recorded-fixture HTTP test pattern — NO live network in CI

Principle (principles.md): "No test mocks for filesystem" / "no fs/network mocks beyond fixtures." The codebase has NO nock/msw dependency. The sanctioned pattern is **inject the dependency**, exactly like `engine.test.ts:623-628` injects a `MedlineSource` and `{chat: vi.fn()}` injects the LLM.

**Two clean injection seams for THIS sprint (use both):**

1. **Inject a fake `MedlineSource` (or its `fetchImpl`/`FetchLike`)** so `medline-source.test.ts` and `literature.test.ts` never reach MedlinePlus:
   ```ts
   import fixture from "./__fixtures__/medlineplus-sample.json" with { type: "json" };
   // ^ NodeNext JSON import assertion; OR read it via node:fs/promises readFile + JSON.parse.
   const fakeFetch: FetchLike = async () =>
     new Response(JSON.stringify(fixture), { status: 200, headers: { "content-type": "application/json" } });
   const egress = new EgressGuard(false, true); // literature ON
   const source = new MedlineSource(egress, fakeFetch);
   const outcome = await source.fetchPassages("metformin");
   expect(outcome).toEqual({ kind: "grounded", passages: expect.any(Array) });
   ```
   `Response` is a declared global (`eslint.config.js:23`) and available in Node 18+/undici. For the throw case: `const fakeFetch: FetchLike = async () => { throw new Error("down"); }` => expect `{kind:'abstain',reason:'source-error'}`.

2. **Inject `{chat: vi.fn()}` for the LLM** (Section 2). synthesize never makes a real LLM call in tests.

**Fixture file** (`__fixtures__/medlineplus-sample.json`): commit a sanitized recorded MedlinePlus response. JSON imports under NodeNext use `with { type: "json" }`, or load via `readFile(new URL("./__fixtures__/medlineplus-sample.json", import.meta.url), "utf-8")` then `JSON.parse` (principles: fs ops use `node:fs/promises`). The fixture shape must match whatever `parseMedline` expects — see Section 6.

**Optional live integration test:** behind an env flag (e.g. `if (!process.env.MEDLINE_LIVE) it.skip(...)`), skipped by default. Never run live in CI.

---

## 6. MedlinePlus endpoint + parse (Q2 resolution)

**Q2 (spec-20260616-medical-team.json:20-24):** "MedlinePlus / NIH open APIs (consumer-health, no OAuth) ... accessed only behind the `literature-retrieval` egress axis; CI uses recorded/fixture responses, no live network."

The architecture doc does not pin an exact URL — the contract assumption (`assumptions[0]`) names the **MedlinePlus Connect / Web service / health-topics API (no OAuth)**. Two real no-auth options (pick ONE; document it in a comment):

- **MedlinePlus Web Service (health-topics search), JSON:**
  `https://wsearch.nlm.nih.gov/ws/query?db=healthTopics&term=<query>&rettype=brief&retmax=10` — supports `&retformat=json` on the newer service; returns a `nlmSearchResult` with `list.document[]` entries, each having `content` fields (title, snippet, URL). Parse each `document` into a `Passage { title, url, text, source: 'medlineplus' }`.
- **MedlinePlus Connect Web service:** `https://connect.medlineplus.gov/service?...&knowledgeResponseType=application/json` — returns a `feed.entry[]` with `title.value`, `link[].href`, `summary.value`. Parse `feed.entry[]` into `Passage[]`.

**Because CI uses a committed fixture, the EXACT live URL is secondary — the fixture you commit defines the parse contract.** Build the fixture to mirror your chosen endpoint's JSON, write `parseMedline(json): Passage[]` to read it, and assert in tests. Map empty results to `{kind:'abstain',reason:'no-passages'}`. Recommended: use the JSON form (`retformat=json` / `knowledgeResponseType=application/json`) so you parse `res.json()` not XML — avoids adding an XML parser.

**Citations** derive from each `Passage`: `{ title: passage.title, url: passage.url, source: "medlineplus" }`.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|---|---|---|---|
| `src/medical/engine.ts` | `RetrievalOutcome` (medline-source.ts:36), `LiteratureRetriever` (:29) | medium | `composeBody` (`engine.ts:137-179`) reads `outcome.kind`; if `passages` widens to `Passage[]`, composeBody only checks `kind`, so safe — verify it does not read `.passages` as strings |
| `src/medical/engine.test.ts` | `MedlineSource`, `LiteratureRetriever`, `RetrievalOutcome` | high | Tests at :613-687 assert `disabled`/abstain on OFF + axis-on source-called; extend to add grounded+cited; do NOT break the `disabled` assertion at :668 |
| `src/medical/retrieval/literature.ts` | `MedlineSource` ctor | medium | `new MedlineSource()` default at :15 must become `new MedlineSource(egress)` once the ctor takes egress |
| `src/orchestrator/workflow/selector.ts:126` | `new MedicalSopEngine()` zero-arg | high | Constructor MUST stay zero-arg constructable (`engine.ts:193` `deps?` optional). Do NOT add required ctor args |
| `src/medical/team.ts` | `MedicalAnswer`/`Citation` types | low | Filling `Citation` fields is additive; verify team.ts does not destructure citation fields that don't exist |

### Existing Tests That Must Still Pass
- `src/medical/engine.test.ts` — full SOP incl. consent/red-flag/numeric/disabled-literature (:342, :399, :548, :613). The numeric/red-flag/disabled paths assert `llmSpy.chat` NOT called (:374, :595, :661) and `retrieve` returns `{kind:'disabled'}` on OFF (:668). Your synthesize wiring must keep zero LLM on those paths.
- `src/medical/egress.test.ts` — axis independence (:25-37). Unchanged; verify your code does not flip `cloud-inference`.
- `src/medical/team.test.ts`, `disclaimer.test.ts`, `consent.test.ts`, `guardrails.test.ts`, `numerics.test.ts`, `health-store.test.ts`, `ingestion.test.ts` — S1-S6, must stay green.
- `src/providers/factory.test.ts` — if you call `createClient`, do not change factory behavior.

### Features That Could Be Affected
- **feat-1 (pipeline plumbing / selector):** shares `MedicalSopEngine` + the zero-arg ctor. Verify `selector.ts:126` still compiles and `bober chat medical` resolution unchanged.
- **feat-6 (EgressGuard + ESLint boundary):** shares the ESLint glob. Adding `fetch` ONLY in `medline-source.ts` preserves it. Adding it anywhere else fails `sc-7-3`.

### Recommended Regression Checks (run after implementation)
1. `npm run build` (sc-7-1) — zero TS errors.
2. `npm run typecheck` (sc-7-2) — zero errors.
3. `npm run lint` (sc-7-3) — green. Then: `grep -rn "fetch\|undici\|node:http\|node:https" src/medical/ --include=*.ts` should show network usage ONLY in `medline-source.ts` (and string literals/comments, not test files).
4. `npm test -- src/medical` (sc-7-4..8) — all medical tests green, incl. new retrieval/literature tests with fixtures.
5. `npm test` — full suite green (S1-S6 unaffected).

---

## 8. Implementation Sequence (dependency-ordered)

1. **src/medical/types.ts** — fill `Citation { title; url; source }`; remove the empty-object eslint-disable at :33. (Optionally declare `Passage` here.)
   - Verify: `npm run typecheck` still passes; existing tests reading `MedicalAnswer` unaffected.
2. **src/medical/retrieval/medline-source.ts** — add `Passage` type (if not in types.ts), widen `RetrievalOutcome.grounded.passages` to `Passage[]`, add `EgressGuard` + injectable `FetchLike` to the ctor, implement `fetchPassages`: `egress.assertAllowed("literature-retrieval")` then `fetchImpl` -> parse -> `grounded | abstain{no-passages} | abstain{source-error}`; wrap in try/catch (NEVER throw out). `fetch`/`Response` allowed ONLY here.
   - Verify: `npm run lint` — the network usage lints clean here and nowhere else.
3. **src/medical/retrieval/literature.ts** — update default `source = new MedlineSource(egress)`; keep the `isAllowed` short-circuit (:30) byte-identical; add `synthesize(query, outcome, llm, footer)` (single `llm.chat`, abstain-unless-supported, >=1 citation, fail-closed on throw).
   - Verify: typecheck; the OFF path still returns `{kind:'disabled'}`.
4. **src/medical/engine.ts** — in the retrieval branch (:344-363), on `outcome.kind==='grounded'` call `synthesize` (using `deps.llmClient` or a lazily-constructed local Ollama client) and use its `MedicalAnswer`; non-grounded branches unchanged; audit event from synthesized `abstained`. Keep zero LLM on numeric/disabled/red-flag paths.
   - Verify: existing engine tests (`llmSpy.chat` not called on numeric/disabled) still pass.
5. **src/medical/retrieval/__fixtures__/medlineplus-sample.json** — commit a sanitized recorded MedlinePlus JSON response matching `parseMedline`.
6. **src/medical/retrieval/medline-source.test.ts** — inject fake `FetchLike`: fixture -> grounded; throw/`!ok` -> abstain{source-error}; empty -> abstain{no-passages}; axis OFF (`new EgressGuard(false,false)`) -> `assertAllowed` throws => caught => abstain (or assert the guard throws). (sc-7-5, sc-7-7)
7. **src/medical/retrieval/literature.test.ts** — fake source + `{chat: vi.fn().mockResolvedValue(supported)}` => grounded + `citations.length>=1`, `abstained=false`; fake LLM returning empty/ABSTAIN => `abstained=true`; fake source throwing => abstain; axis OFF => `{kind:'disabled'}`; `chat: vi.fn().mockRejectedValue(...)` => abstained + "model unavailable", assert NO cloud provider constructed. (sc-7-5, sc-7-6, sc-7-7, sc-7-8)
8. **Extend src/medical/engine.test.ts** — add a grounded+cited end-to-end case (axis ON, fake source via injected `literature`, fake `llmClient` supported) asserting `abstained=false`, `citations.length>=1`, audit `event==='answer'`.
9. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run lint`, `npm test`.

---

## 9. Pitfalls & Warnings

- **The single-network-file rule is the #1 failure mode.** Any `fetch`/`undici`/`node:http` token in `literature.ts`, `engine.ts`, OR any `.test.ts` under `src/medical/` fails `sc-7-3`. Inject a `FetchLike` into `MedlineSource` instead — the fake fetch lives in the TEST file, but the test file is still under `src/medical/` and the `fetch` GLOBAL is banned there too (`eslint.config.js:93-96`). So in tests, build the fake with `new Response(...)` (Response is allowed; only `fetch` the global is banned) OR define `FetchLike` to return a plain object `{ ok, json: async () => fixture, status }` and avoid `Response` entirely. Safest: tests inject a `fetchImpl` that returns a duck-typed object, never call the global `fetch`.
- **`assertAllowed` BEFORE `fetch`** — not after, not skipped. Put it as the first statement in `fetchPassages`. The OFF-axis test relies on it (or on the `literature.ts:30` short-circuit) to prove zero egress.
- **Keep the `literature.ts:30` `isAllowed` short-circuit byte-identical** — `engine.test.ts:666-668` asserts `retrieve` returns exactly `{ kind: "disabled" }` and `MedlineSource.fetchPassages` is NOT called when off.
- **Zero-arg constructor invariant** — `selector.ts:126` does `new MedicalSopEngine()`. Do NOT add required constructor params. New deps go in the optional `MedicalSopDeps` (`engine.ts:46-65`).
- **Never auto-fallback to cloud.** If the local Ollama client throws, abstain. Constructing a cloud client in the literature path fails `sc-7-8`.
- **consistent-type-imports is errored** (`eslint.config.js:39`) — import `LLMClient`, `MedicalAnswer`, `Citation`, `Passage`, `RetrievalOutcome` with `import type`. `EgressGuard` is used as a value (`assertAllowed`/`isAllowed`/`new`), so import it as a value; `createClient` is a value import.
- **No synchronous fs** (principles) — load the fixture with `node:fs/promises` `readFile` + `JSON.parse`, or a NodeNext JSON import assertion. Never `readFileSync`.
- **`no-explicit-any` is warned** — type the parsed MedlinePlus JSON with `unknown` + narrowing, not `any`.
- **`Citation` currently has an `eslint-disable-next-line @typescript-eslint/no-empty-object-type`** (`types.ts:33`) — remove it once you add fields, or the now-unnecessary disable may itself warn.
- **Do not widen `RetrievalOutcome` in a non-additive way** — `engine.ts:36` imports it as a type and `composeBody` reads only `.kind`. Widening `passages` from `string[]` to `Passage[]` is safe; renaming `kind`/`reason` is not.
- **CI/`BOBER_TEST_DETERMINISTIC`** — `createClient` returns a stub when that env is set (`factory.ts:182`). Tests should inject `deps.llmClient` directly so they don't depend on this; production grounded synthesis uses the real local client.
