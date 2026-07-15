# Sprint Briefing: Gated synthesis flow + engine wiring

**Contract:** sprint-spec-20260618-medical-grounding-critic-2
**Generated:** 2026-06-18T16:30:00Z

---

## 0. What you are building (one paragraph)

Add `synthesizeGrounded(query, outcome, llm, footer)` to `src/medical/retrieval/literature.ts` — a fail-closed gate that runs `synthesize`, critiques the result with the Sprint-1 `getGroundingVerdict`, re-synthesizes ONCE with critic feedback on reject, and ABSTAINS on second-reject or any thrown error. Then swap `synthesize` → `synthesizeGrounded` at the single call site `src/medical/engine.ts:403`. Every non-grounded path (consent/red-flag/refuse/numeric/disabled) must stay byte-identical and zero-LLM. Add an exported constant `GROUNDED_GATE_MAX_LLM_CALLS` computed from `GROUNDING_MAX_LLM_CALLS`. Add collocated tests. No new SDK/network imports under `src/medical`.

---

## 1. Target Files

### `src/medical/retrieval/literature.ts` (modify — add `synthesizeGrounded`)

The new code goes NEXT TO `synthesize` so it reuses the module-private helpers (`buildSynthesisSystem`, `passagesToCitations`) and the constant `SYNTHESIS_MODEL`.

**`synthesize` signature you call (literature.ts:98-103):**
```ts
export async function synthesize(
  query: string,
  outcome: RetrievalOutcome,
  llm: LLMClient,
  footer: string,
): Promise<MedicalAnswer> {
```

**The abstain return SHAPE used everywhere in synthesize (literature.ts:106-114) — copy this exact field set for `abstainAnswer(footer)`:**
```ts
return {
  body: "...canned message...",
  abstained: true,
  citations: [],
  disclaimerFooter: footer,
  shortCircuit: false,
};
```
All five fields are MANDATORY — `MedicalAnswer` has no optional fields (`src/medical/types.ts:40-46`: `body`, `abstained`, `citations`, `disclaimerFooter`, `shortCircuit`).

**The single LLM call inside synthesize (literature.ts:135-140) — note the exact ChatParams keys:**
```ts
const response = await llm.chat({
  model: SYNTHESIS_MODEL,
  system: buildSynthesisSystem(passages),
  messages: [{ role: "user", content: query }],
  maxTokens: SYNTHESIS_MAX_TOKENS,
});
```

**`buildSynthesisSystem` (literature.ts:54-67)** is module-private (NOT exported). To append critic feedback you must add a sibling helper in THE SAME FILE — do NOT export `buildSynthesisSystem` or change its signature (contract assumption literature.ts:75). Implement `synthesizeWithFeedback` as a near-copy of `synthesize` that appends ONE extra system line, OR factor the system string. The simplest correct form keeps `synthesize` untouched and adds a private helper.

**Constants in this file:** `SYNTHESIS_MODEL = "ollama/llama3"` (literature.ts:46), `SYNTHESIS_MAX_TOKENS = 512` (literature.ts:47).

**Imports this file already has (literature.ts:1-5):**
```ts
import type { EgressGuard } from "../egress.js";
import { MedlineSource, type RetrievalOutcome, type Passage } from "./medline-source.js";
import type { LLMClient } from "../../providers/types.js";
import type { MedicalAnswer, Citation } from "../types.js";
```
**You must ADD:** `import { getGroundingVerdict, GROUNDING_MAX_LLM_CALLS } from "./grounding-critic.js";`
(grounding-critic.js is in the SAME directory — relative `./grounding-critic.js`, with the `.js` ESM extension. This is NOT an SDK/network import, so the ESLint medical boundary stays green.)

**Imported by:** `src/medical/engine.ts:29` (`import { LiteratureRetriever, synthesize } from "./retrieval/literature.js";`). After this sprint, also import `synthesizeGrounded` there.

**Test file:** `src/medical/retrieval/literature.test.ts` (EXISTS, 243 lines). The contract also allows a new sibling `src/medical/retrieval/grounded-gate.test.ts` — prefer collocating the gate tests there to keep `literature.test.ts` focused, OR extend `literature.test.ts`. Both are listed in `estimatedFiles`.

---

### `src/medical/retrieval/grounded-gate.test.ts` (create)

**Directory pattern:** all retrieval tests are collocated `*.test.ts` next to source (`literature.test.ts`, `grounding-critic.test.ts`, `medline-source.test.ts`). kebab-no — they use the source filename + `.test.ts`.
**Most similar existing file:** `src/medical/retrieval/grounding-critic.test.ts` — copy its `ScriptedClient` fake (lines 12-25). Reproduced in §6.

---

### `src/medical/engine.ts` (modify — swap call site only)

**The grounded branch you replace (engine.ts:393-415):**
```ts
const hasNumericAnswer = numericResult !== null && numericResult.sampleCount > 0;   // :393

let answer: MedicalAnswer;
if (outcome.kind === "grounded" && !hasNumericAnswer) {                              // :396
  // ── Grounded synthesis path ───────────────────────────────────────
  const llmClient: LLMClient = this.deps?.llmClient ?? createClient("openai-compat", "http://localhost:11434/v1", undefined, "llama3");  // :402 — KEEP UNCHANGED
  answer = await synthesize(userPrompt, outcome, llmClient, footer);                 // :403 — CHANGE THIS LINE ONLY
} else {                                                                             // :404
  // ── Numeric / disabled / abstain path ─────────────────────────────  KEEP UNTOUCHED (:404-415)
  const abstained = !hasNumericAnswer;
  answer = { body: composeBody(numericResult, activeMeds, outcome), abstained, citations: [], disclaimerFooter: footer, shortCircuit: false };
}

await auditLog.append({ tIso: now, event: answer.abstained ? "abstain" : "answer", rulesetVersion });  // :417 — KEEP UNCHANGED
```

**The ONLY change:** line 403 becomes
```ts
answer = await synthesizeGrounded(userPrompt, outcome, llmClient, footer);
```
Plus update the import at engine.ts:29 to also import `synthesizeGrounded`. The lazy `llmClient` construction (engine.ts:400-402), the `hasNumericAnswer` guard (engine.ts:393), the else-branch (engine.ts:404-415), and the `auditLog.append` (engine.ts:417) all stay byte-identical. Do NOT touch consent (engine.ts:217-248), red-flag (engine.ts:255-289), refuse (engine.ts:293-327), or numerics (engine.ts:338-363).

**Imported by:** `src/orchestrator/workflow/selector.ts` (constructs `new MedicalSopEngine()` zero-arg — DO NOT change the constructor or `run` signature, contract nonGoal). Only `engine.test.ts` and `selector.ts` import it; blast radius is tiny.

**Test file:** `src/medical/engine.test.ts` (EXISTS, 1049 lines).

---

## 2. Patterns to Follow

### Pattern A — The exact `synthesizeGrounded` algorithm (fail-closed, try/catch→abstain)
**Source basis:** generatorNotes + literature.ts:98-177 + grounding-critic.ts:170-207.
Note: `synthesize` itself never throws on an LLM error — it catches and returns an abstained answer (literature.ts:142-153). BUT `getGroundingVerdict` DOES let transport errors PROPAGATE (it only fail-closes on *parse* exhaustion at grounding-critic.ts:206; a thrown `llm.chat` rejection escapes). Therefore the critic calls MUST be wrapped in try/catch. Wrapping `synthesize` in try/catch too is belt-and-braces (cheap, and the contract sc-2-5 demands "synthesize throws → abstain").

```ts
export async function synthesizeGrounded(
  query: string,
  outcome: RetrievalOutcome,
  llm: LLMClient,
  footer: string,
): Promise<MedicalAnswer> {
  // Non-grounded outcomes are already handled by synthesize (disabled/abstain → abstained).
  if (outcome.kind !== "grounded") {
    return synthesize(query, outcome, llm, footer);
  }

  // 1) First synthesis.
  let answer: MedicalAnswer;
  try {
    answer = await synthesize(query, outcome, llm, footer);
  } catch {
    return abstainAnswer(footer);
  }
  if (answer.abstained) return answer; // synthesize abstained (empty/ABSTAIN/no-passages/model-unavailable)

  // 2) First critique. getGroundingVerdict PROPAGATES transport errors → wrap.
  let verdict: GroundingVerdict;
  try {
    verdict = await getGroundingVerdict({
      llm, model: SYNTHESIS_MODEL, question: query,
      answerBody: answer.body, passages: outcome.passages,
    });
  } catch {
    return abstainAnswer(footer);
  }
  if (verdict.verdict === "approve") return answer;

  // 3) ONE re-synthesis with critic feedback appended to the system prompt.
  let answer2: MedicalAnswer;
  try {
    answer2 = await synthesizeWithFeedback(query, outcome, llm, footer, verdict.feedback);
  } catch {
    return abstainAnswer(footer);
  }
  if (answer2.abstained) return answer2;

  // 4) Re-critique.
  let verdict2: GroundingVerdict;
  try {
    verdict2 = await getGroundingVerdict({
      llm, model: SYNTHESIS_MODEL, question: query,
      answerBody: answer2.body, passages: outcome.passages,
    });
  } catch {
    return abstainAnswer(footer);
  }
  return verdict2.verdict === "approve" ? answer2 : abstainAnswer(footer);
}
```
`GroundingVerdict` type is exported from grounding-critic.ts:32 (`export type GroundingVerdict = z.infer<typeof GroundingVerdictSchema>` → `{ verdict: "approve"|"reject"; feedback: string }`). Import it as a type.

**Rule:** every awaited LLM-reaching call sits inside its own try/catch that returns `abstainAnswer(footer)`; the only non-abstain returns are `answer` (1st approve) and `answer2` (2nd approve).

### Pattern B — `abstainAnswer(footer)` helper
**Source basis:** the abstain shape at literature.ts:106-114; canned message from generatorNotes.
```ts
function abstainAnswer(footer: string): MedicalAnswer {
  return {
    body:
      "I cannot provide a sufficiently-supported answer grounded in the retrieved literature. " +
      "For evidence-based guidance, please consult a licensed healthcare professional.",
    abstained: true,
    citations: [],
    disclaimerFooter: footer,
    shortCircuit: false,
  };
}
```
**Rule:** abstained answers ALWAYS have `citations: []`, `abstained: true`, `shortCircuit: false`, and carry the footer (sc-2-4 asserts all three).

### Pattern C — `synthesizeWithFeedback` (re-synthesis with feedback)
**Source basis:** literature.ts:132-177 (the synthesize LLM-call body) + buildSynthesisSystem at literature.ts:54-67.
The cleanest approach that leaves `synthesize` untouched: copy synthesize's grounded body into a private helper that appends one line to the system prompt. The system string must STILL pin the same passages.
```ts
async function synthesizeWithFeedback(
  query: string,
  outcome: Extract<RetrievalOutcome, { kind: "grounded" }>,
  llm: LLMClient,
  footer: string,
  feedback: string,
): Promise<MedicalAnswer> {
  const passages = outcome.passages;
  if (passages.length === 0) return abstainAnswer(footer); // mirrors literature.ts:120-130
  const system =
    buildSynthesisSystem(passages) +
    `\n\nAddress this reviewer feedback while staying grounded ONLY in the passages: ${feedback}`;
  let responseText: string;
  try {
    const response = await llm.chat({
      model: SYNTHESIS_MODEL,
      system,
      messages: [{ role: "user", content: query }],
      maxTokens: SYNTHESIS_MAX_TOKENS,
    });
    responseText = response.text.trim();
  } catch {
    return abstainAnswer(footer);
  }
  if (!responseText || responseText.toUpperCase() === "ABSTAIN") return abstainAnswer(footer);
  return {
    body: responseText,
    abstained: false,
    citations: passagesToCitations(passages),
    disclaimerFooter: footer,
    shortCircuit: false,
  };
}
```
**Rule:** the second synthesis pins the SAME `outcome.passages` (contract assumption); only the system prompt gains one feedback line. `passagesToCitations` (literature.ts:75-81) guarantees `citations.length >= 1` for a non-abstained answer (sc-2-4).

### Pattern D — `GROUNDED_GATE_MAX_LLM_CALLS` budget (compute, don't hardcode)
**Source basis:** GROUNDING_MAX_LLM_CALLS at grounding-critic.ts:9 (`= 1 + GROUNDING_PARSE_MAX_RETRIES` = 2).
Worst case = 1 synth + GROUNDING_MAX_LLM_CALLS critic + 1 re-synth + GROUNDING_MAX_LLM_CALLS re-critic.
```ts
import { getGroundingVerdict, GROUNDING_MAX_LLM_CALLS, type GroundingVerdict } from "./grounding-critic.js";

export const GROUNDED_GATE_MAX_LLM_CALLS =
  1 + GROUNDING_MAX_LLM_CALLS + 1 + GROUNDING_MAX_LLM_CALLS; // = 6 today (1+2+1+2)
```
**Rule:** derive from the imported constant (sc-2-7 / evaluatorNotes "compute from the imported constant, not a literal"). With today's GROUNDING_MAX_LLM_CALLS=2 the value is 6. Note: the call-cap TEST drives reject→reject where the critic returns VALID JSON on the first attempt each time, so the OBSERVED count on that path is 4 (1 synth + 1 critic + 1 re-synth + 1 re-critic). Assert `chat calls <= GROUNDED_GATE_MAX_LLM_CALLS` (sc-2-7 says "at most"), which holds for 4 <= 6. Do NOT assert exact equality to 6 unless you force parse-retries.

### Pattern E — Critique-loop structural model (accept-on-approve / abstain-on-exhaustion)
**Source:** `src/fleet/critic-deep.ts:206-265` (`runCritiqueLoop`).
```ts
// critic-deep.ts:226-258 — the shape to mirror, with DIFFERENT terminal behavior
try { verdict = await getCriticVerdict(...); } catch { break; }   // transport → exit loop
if (verdict.verdict === "approve") return current;                // approve → accept
if (reExpandsLeft <= 0) break;                                    // exhausted → exit
reExpandsLeft -= 1;
try { const reExpanded = await runExpandStage(...); } catch { break; }
```
**Rule:** critic-deep ACCEPTS-BEST on exhaustion/throw (fleet, fail-open, critic-deep.ts:262-264). The medical gate is the INVERSE: ABSTAINS on exhaustion/throw (fail-closed). Cap at exactly ONE re-synthesis (no `while` loop needed — the linear algorithm in Pattern A is clearer than a loop here).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `synthesize` | `src/medical/retrieval/literature.ts:98` | `(query, outcome, llm, footer): Promise<MedicalAnswer>` | Single-call grounded synthesis; handles disabled/abstain/empty/ABSTAIN/model-unavailable → abstained. CALL IT, don't reimplement. |
| `buildSynthesisSystem` | `src/medical/retrieval/literature.ts:54` | `(passages: Passage[]): string` | Module-private; pins passages + ABSTAIN instruction. Reuse via `synthesizeWithFeedback`. |
| `passagesToCitations` | `src/medical/retrieval/literature.ts:75` | `(passages: Passage[]): Citation[]` | Module-private; maps passages → citations (guarantees >=1). |
| `getGroundingVerdict` | `src/medical/retrieval/grounding-critic.ts:170` | `({ llm, model, question, answerBody, passages }): Promise<GroundingVerdict>` | Sprint-1 critic; FAIL-CLOSED reject on parse exhaustion; THROWS on transport error (propagates — wrap in try/catch). |
| `GROUNDING_MAX_LLM_CALLS` | `src/medical/retrieval/grounding-critic.ts:9` | `= 1 + GROUNDING_PARSE_MAX_RETRIES` (=2) | The critic's per-call LLM budget; use to compute the gate budget. |
| `GroundingVerdict` (type) | `src/medical/retrieval/grounding-critic.ts:32` | `{ verdict: "approve"\|"reject"; feedback: string }` | Verdict type to annotate locals. |
| `validateGroundingVerdict` | `src/medical/retrieval/grounding-critic.ts:40` | `(rawText): ValidateGroundingResult` | Never-throws parser; NOT needed by the gate (getGroundingVerdict wraps it). |
| `SYNTHESIS_MODEL` | `src/medical/retrieval/literature.ts:46` | `"ollama/llama3"` | Module-private model string passed to getGroundingVerdict `model:`. |

Utilities reviewed: no `src/utils|lib|helpers|shared|common` helper applies to this gate — it is self-contained within `src/medical/retrieval/`.

---

## 4. Prior Sprint Output

### Sprint 1: grounding critic (commit 10bb964)
**Created:** `src/medical/retrieval/grounding-critic.ts` — exports `getGroundingVerdict`, `validateGroundingVerdict`, `buildGroundingSystemPrompt`, `GroundingVerdictSchema`, `GroundingVerdict` (type), `ValidateGroundingResult` (type), `GROUNDING_PARSE_MAX_RETRIES` (=1), `GROUNDING_MAX_LLM_CALLS` (=2).
**Created:** `src/medical/retrieval/grounding-critic.test.ts` (has the `ScriptedClient` fake — reuse it).
**Connection to this sprint:** `synthesizeGrounded` imports `getGroundingVerdict` + `GROUNDING_MAX_LLM_CALLS`. CRITICAL behavior to remember: `getGroundingVerdict` returns `{ verdict: "reject", feedback: "<unparseable critic output>" }` on parse exhaustion (grounding-critic.ts:206 — fail-closed, does NOT throw), but a thrown `llm.chat` rejection PROPAGATES out (no try/catch around the loop body at grounding-critic.ts:183-201). So your gate must try/catch every `getGroundingVerdict` call.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` consulted for this sprint (the medical module's invariants live in code + ADR comments). Core invariant from engine.ts:1-18 and the contract: **non-grounded paths construct NO LLM client and make NO LLM call** (zero-egress / fail-closed). The lazy `llmClient` construction is intentionally inside the grounded branch (engine.ts:400-402) precisely so the other paths never build one.

### Architecture Decisions
Inline ADR references in code:
- **ADR-6** (medline-source.ts:1, literature.ts:1): the literature-retrieval egress axis defaults OFF; `LiteratureRetriever.retrieve` returns `{disabled}` synchronously when off. The ONLY file permitted network imports under `src/medical` is `medline-source.ts`. `synthesizeGrounded` adds NO network import → boundary stays green (sc-2-8).
- **Fail-closed inversion** (grounding-critic.ts:203-206): the medical critic rejects on parse exhaustion, opposite of fleet critic-deep.ts:199-201 which approves (fail-open). Your gate continues this fail-closed posture by abstaining on second-reject/throw.

### Other Docs
No `CLAUDE.md`/`CONTRIBUTING.md` rule specific to this sprint beyond: TypeScript strict ESM with `.js` import extensions (every relative import ends `.js`), `vitest` for tests, named exports only.

---

## 6. Testing Patterns

### Unit Test Pattern — scripted/queued fake LLM (for grounded-gate.test.ts)
**Source:** `src/medical/retrieval/grounding-critic.test.ts:12-25` — copy `ScriptedClient` verbatim. It returns queued strings in order and records every call, which lets you drive synth→critic→re-synth→re-critic and assert the call count.
```ts
import { describe, it, expect, vi } from "vitest";
import type { LLMClient, ChatParams, ChatResponse } from "../../providers/types.js";

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
Driving the gate (responses are consumed IN ORDER across BOTH synthesize and critic since both call the same `llm.chat`):
- **approve-first (sc-2-3):** queue `["A grounded body about metformin.", '{"verdict":"approve","feedback":""}']` → expect returned answer === first synthesis (body matches, `citations.length >= 1`).
- **reject→approve (sc-2-4):** queue `["body one", '{"verdict":"reject","feedback":"fix x"}', "body two (revised)", '{"verdict":"approve","feedback":""}']` → expect returned `answer.body === "body two (revised)"`, `abstained === false`, `citations.length >= 1`.
- **reject→reject (sc-2-4):** queue `["body one", '{"verdict":"reject","feedback":"a"}', "body two", '{"verdict":"reject","feedback":"b"}']` → expect `abstained === true`, `citations === []` (use `toEqual([])`), `disclaimerFooter` truthy.
- **call-cap (sc-2-7):** same reject→reject script → `expect(client.calls.length).toBeLessThanOrEqual(GROUNDED_GATE_MAX_LLM_CALLS)` (observed 4 with valid JSON; cap is 6).

**Throw-mapping (sc-2-5)** needs a REJECTING fake, not ScriptedClient (ScriptedClient never rejects):
```ts
const throwingLlm: LLMClient = { chat: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")) };
const ans = await synthesizeGrounded("q", GROUNDED_OUTCOME, throwingLlm, FOOTER);
expect(ans.abstained).toBe(true);
expect(ans.citations).toEqual([]);
```
For "critic throws but synth succeeds": use a fake whose first `chat` resolves a body and second `chat` rejects (e.g. `vi.fn().mockResolvedValueOnce({text:"body", ...}).mockRejectedValueOnce(new Error("down"))`).

**Fixtures to reuse (literature.test.ts:19-30, 71):**
```ts
const SAMPLE_PASSAGES: Passage[] = [{ title: "Metformin", url: "https://medlineplus.gov/druginfo/meds/a696005.html", text: "...", source: "medlineplus" }];
const GROUNDED_OUTCOME: RetrievalOutcome = { kind: "grounded", passages: SAMPLE_PASSAGES };
const FOOTER = "This is general wellness information, not medical advice. Consult a healthcare professional.";
```

**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** `vi.fn()` + hand-rolled class fakes implementing `LLMClient`. **File naming:** `<source>.test.ts`. **Location:** collocated next to source.

### Engine dep-injection test pattern (for engine.test.ts grounded path)
**Source:** `src/medical/engine.test.ts:846-932` — the existing "axis ON + grounded source + supported LLM" test. Use it as the template for a grounded-gate test. The harness:
```ts
const { auditLog, gate, disclaimer } = await recordTestConsent(tmpDir2);   // helper at engine.test.ts:299-313
const egress = new EgressGuard(false, true);                                // (cloudInference=false, literatureRetrieval=ON)
const sourceStub = new MedlineSource(egress);
vi.spyOn(sourceStub, "fetchPassages").mockResolvedValue({ kind: "grounded", passages: [...] });
const literature = new LiteratureRetriever(egress, sourceStub);
const llmSpy: LLMClient = { chat: vi.fn().mockResolvedValue({ text: "...", toolCalls: [], stopReason: "end", usage: {...} }) };
const facts = new FactStore(":memory:");
const healthStore = new HealthDataStore(":memory:");
const engine = new MedicalSopEngine({ auditLog, consentGate: gate, disclaimer, llmClient: llmSpy, egress, literature, facts, healthStore });
const result = await engine.run("what are the side effects of metformin?", tmpDir2, config, { now: "2026-06-16T12:00:00.000Z" });
```
NOTE: the existing test at engine.test.ts:846 currently expects `llmSpy.chat` called EXACTLY once (line 913). After your swap, the grounded path makes synth + critic = at least 2 calls. **You MUST update that assertion** (e.g. to `toHaveBeenCalled()` or the gate cap) AND queue a critic-approve response so the gate returns the cited answer. To return distinct synth vs critic outputs from one `vi.fn()`, use `.mockResolvedValueOnce(...synthBody...).mockResolvedValueOnce(...approveJson...)`. The `data-testid`/E2E patterns do not apply (no Playwright in this module).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/medical/engine.ts` | `synthesize` (import literature.ts:29) | medium | Swap to `synthesizeGrounded`; keep import of `synthesize`? No — engine no longer calls `synthesize` directly. Import `synthesizeGrounded` instead (or both if you keep a fallback). |
| `src/medical/engine.test.ts:846-932` | grounded path = 1 LLM call | HIGH | `expect(llmSpy.chat).toHaveBeenCalledTimes(1)` at line 913 WILL FAIL after the gate adds a critic call. Update this test: queue an approve verdict and relax/adjust the call-count assertion. |
| `src/orchestrator/workflow/selector.ts` | `new MedicalSopEngine()` (zero-arg) | low | Constructor + run signature unchanged → no break. Do not modify. |
| `src/medical/retrieval/literature.test.ts` | `synthesize` export | low | `synthesize` is unchanged → existing 17 synthesize tests still pass. Only ADD tests. |

### Existing Tests That Must Still Pass (zero-LLM negative assertions to PRESERVE)
These all inject `llmSpy: LLMClient = { chat: vi.fn() }` and assert `expect(llmSpy.chat).not.toHaveBeenCalled()`. They exercise NON-grounded paths and MUST stay green (sc-2-6). The swap is on the grounded branch only, so they are structurally safe — but VERIFY each still passes:
- `engine.test.ts:124-159` — no-consent refuse: `llmSpy.chat`+`numericsSpy` not called (Gate 1).
- `engine.test.ts:343-396` — 5 red-flag cases (cardiac/stroke/anaphylaxis/self-harm/overdose): `llmSpy.chat`+`numericsSpy` not called (Gate 2 short-circuit).
- `engine.test.ts:400-431` — benign allow path numeric prompt: spies present (this hits the else/numeric branch).
- `engine.test.ts:435-477` — consent-ordering: no-consent emergency, spies not called (Gate 1 before Gate 2).
- `engine.test.ts:549-608` + `engine.test.ts:937-996` — content-policy refuse "prescribe antibiotics": `llmSpy.chat`+`numericsSpy` not called (Gate 2b).
- `engine.test.ts:610-630` + `998-1018` — specific-dosing refuse: `llmSpy.chat` not called.
- `engine.test.ts:665-727` — numeric-only zero-egress (seeded healthStore, sampleCount>0): `llmSpy.chat` not called (numeric answer path, `hasNumericAnswer===true` → else branch).
- `engine.test.ts:729-804` — literature axis OFF → `{disabled}` → abstain: `llmSpy.chat` not called (outcome.kind !== "grounded" → else branch).
- `engine.test.ts:806-844` — axis ON, source returns abstain stub: `sourceSpy` called but no LLM (outcome not grounded → else branch).
- `literature.test.ts:127-145, 199-211` — synthesize disabled/abstain: `llm.chat` not called (unchanged function).

### Features That Could Be Affected
- **Sprint 3 (next):** will add `config.medical` model/provider + cloud gating + `AuditEntry.criticVerdict`. Keep the engine's `auditLog.append` (engine.ts:417) emitting the EXISTING answer/abstain event only — do NOT add a criticVerdict field this sprint (contract nonGoal). Leave room: `synthesizeGrounded` returns a plain `MedicalAnswer`, so the engine's audit logic needs no change.

### Recommended Regression Checks
1. `npm run typecheck` — strict ESM, zero errors.
2. `npm run build` — zero TS errors.
3. `npm run test -- src/medical/engine.test.ts src/medical/retrieval/literature.test.ts src/medical/retrieval/grounded-gate.test.ts src/medical/retrieval/grounding-critic.test.ts` — all green; pay special attention to engine.test.ts:913 (you edited it).
4. `npm run test` — FULL suite, no regression (~2484 tests baseline).
5. `npm run lint` — the scoped medical ESLint boundary passes; confirm NO new `@anthropic-ai/sdk`, `openai`, `node:net`, `node:http`, `fetch(` under `src/medical` (grep the diff).

---

## 8. Implementation Sequence

1. **`src/medical/retrieval/literature.ts`** — add `import { getGroundingVerdict, GROUNDING_MAX_LLM_CALLS, type GroundingVerdict } from "./grounding-critic.js";`. Add `abstainAnswer`, `synthesizeWithFeedback` (private), `export const GROUNDED_GATE_MAX_LLM_CALLS`, and `export async function synthesizeGrounded`. Leave `synthesize` and its helpers untouched.
   - Verify: `npm run typecheck` passes; `synthesize` export still present.
2. **`src/medical/engine.ts`** — change import at line 29 to add `synthesizeGrounded`; change line 403 `synthesize(...)` → `synthesizeGrounded(...)`. Touch nothing else.
   - Verify: `npm run build` passes; grep confirms only one line changed in the grounded branch.
3. **`src/medical/retrieval/grounded-gate.test.ts`** (create) — copy `ScriptedClient`; add tests for approve, reject→approve, reject→reject→abstain, synth-throw→abstain, critic-throw→abstain, call-cap. Cover sc-2-3,2-4,2-5,2-7.
   - Verify: `npm run test -- src/medical/retrieval/grounded-gate.test.ts` green.
4. **`src/medical/engine.test.ts`** — FIX the existing grounded test at :846-932 (queue an approve verdict; adjust the `toHaveBeenCalledTimes(1)` at :913). Add ONE new grounded-gate engine test if helpful (reject→approve through the engine). Re-confirm all zero-LLM negative assertions still pass (they should be untouched).
   - Verify: `npm run test -- src/medical/engine.test.ts` green.
5. **`src/medical/retrieval/literature.test.ts`** — optionally add gate tests here instead of (or in addition to) grounded-gate.test.ts. Synthesize tests are unchanged.
   - Verify: green.
6. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run test`, `npm run lint`.

---

## 9. Pitfalls & Warnings

- **engine.test.ts:913 `toHaveBeenCalledTimes(1)` WILL FAIL** after the swap — the gate adds a critic call. This is the single most likely regression. Update that test: queue an approve verdict via `.mockResolvedValueOnce` and change the count assertion.
- **`getGroundingVerdict` PROPAGATES transport throws** (no try/catch around its loop body, grounding-critic.ts:183-201) — it only fail-closes on PARSE exhaustion (returns reject). Your gate MUST wrap every `getGroundingVerdict` call in try/catch → abstain (sc-2-5). Do not assume it's caught internally.
- **`synthesize` does NOT throw on LLM error** (it catches at literature.ts:142 and returns an abstained answer). So after `answer = await synthesize(...)`, an `answer.abstained` check (NOT a try/catch) is what returns early for model-unavailable. The try/catch around synthesize is belt-and-braces for the contract's "synthesize throws → abstain" wording.
- **`buildSynthesisSystem` and `passagesToCitations` are module-private** (no `export` at literature.ts:54, :75). You can use them freely from `synthesizeWithFeedback` in the SAME file — do NOT export them (would widen the public surface and risk a lint/contract violation).
- **Compute `GROUNDED_GATE_MAX_LLM_CALLS` from `GROUNDING_MAX_LLM_CALLS`, never a literal** (evaluatorNotes). Value is 6 today. The reject→reject test with valid-JSON verdicts only makes 4 calls — assert `<=` the constant, not `===`.
- **`SYNTHESIS_MODEL` is `"ollama/llama3"`** (literature.ts:46) — pass it as the `model:` to `getGroundingVerdict`. Do not invent a model name. (The engine's `createClient` at engine.ts:402 uses `"llama3"` for the openai-compat default; the synthesize layer's model string is separate and is what you forward to the critic.)
- **Do NOT add `config.medical`, cloud-inference gating, or `AuditEntry.criticVerdict`** — all Sprint 3 (contract nonGoals/outOfScope). The engine keeps appending only the existing answer/abstain event (engine.ts:417).
- **Do NOT change `MedicalSopEngine.run` signature or the zero-arg constructor** — `selector.ts` depends on `new MedicalSopEngine()`.
- **Responses queue is SHARED** between synthesize and critic in `ScriptedClient` (both call `llm.chat`). When scripting, interleave: synth-body, critic-verdict, re-synth-body, re-critic-verdict — in that exact order.
- **ESM `.js` extensions** on every relative import (`./grounding-critic.js`, `./medline-source.js`) — strict mode rejects extensionless relative imports.
