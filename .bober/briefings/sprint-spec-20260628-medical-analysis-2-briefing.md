# Sprint Briefing: Recommendation judge-loop core — 4-lens panel, contraindication VETO, fail-closed dissent

**Contract:** sprint-spec-20260628-medical-analysis-2
**Generated:** 2026-06-28T00:00:00.000Z

> **Two highest-risk requirements — read first:**
> 1. **FAIL-CLOSED INVERSION.** This panel must mirror `src/medical/retrieval/grounding-critic.ts:206` (reject on parse exhaustion), NOT `src/fleet/critic-deep.ts:206` (approve on exhaustion). Every "I don't know" — unparseable verdict, thrown lens client, tie, exhausted rounds — resolves to **NOT accepted**. Put a comment in `judge-panel.ts`/`lenses.ts` referencing `grounding-critic.ts:206` vs `critic-deep.ts:206` (evaluatorNotes require it).
> 2. **ABSOLUTE VETO.** Any single `veto:true` from the contraindication-checker forces `accepted:false` with `reason:'contraindication-veto'` REGARDLESS of approve count. A 3-approve/1-veto panel is REJECTED. No code path may let a vote majority override a veto.

---

## 1. Target Files

All five files are **create** (the `src/medical/recommend/` directory does not yet exist — confirmed via `ls`). The estimated files:
- `src/medical/recommend/types.ts` (verdict / outcome / lens shapes)
- `src/medical/recommend/lenses.ts` (four lens prompt builders + `validateLensVerdict`)
- `src/medical/recommend/lenses.test.ts`
- `src/medical/recommend/judge-panel.ts` (`reconcilePanel` + `runJudgeLoop`)
- `src/medical/recommend/judge-panel.test.ts`

### Directory / naming conventions (siblings)
- Module dir: `src/medical/recommend/` (kebab-case dir, lower-kebab `.ts` files; tests collocated as `*.test.ts`). Mirrors `src/medical/analysis/` (`finding.ts` + `finding.test.ts`, `review-pass.ts` + `review-pass.test.ts`) and `src/medical/retrieval/` (`grounding-critic.ts` + `grounding-critic.test.ts`).
- **ESM/NodeNext**: every relative import MUST carry a `.js` extension (e.g. `import type { LLMClient } from "../../providers/types.js"` — see `grounding-critic.ts:3`). Importing `../types.js` reaches `src/medical/types.ts`.
- File header doc-comment stating purity invariants is the house style — see `finding.ts:1-14` and `review-pass.ts:1-13` ("PURE / NO network / NO LLM"). Add one: "PURE orchestration over injected fns — NO fs / NO network / NO real provider / NO FactStore".

### Most-similar existing files to template from
| New file | Template file | Why |
|----------|--------------|-----|
| `lenses.ts` | `src/medical/retrieval/grounding-critic.ts` | constants → coercion prompt → Zod schema → `validateX` (never-throws) → `buildXSystemPrompt` → internal one-call → `getXVerdict` loop |
| `judge-panel.ts` | `src/fleet/critic-deep.ts:211-278` (`runCritiqueLoop`) | regenerate-on-reject loop skeleton + budget constant — INVERTED to fail-closed |
| `types.ts` | `src/medical/types.ts:11-14` (`GuardrailVerdict` union) | discriminated-union outcome style |
| `*.test.ts` | `src/medical/retrieval/grounding-critic.test.ts` | `ScriptedClient`, throwing client, `it.each(...).not.toThrow`, budget-cap assertions |

---

## 2. Patterns to Follow

### Pattern A — Never-throwing verdict validator (COPY THIS, add `veto`)
**Source:** `src/medical/retrieval/grounding-critic.ts:40-88`. The four-tier JSON extraction (direct parse → fenced ```json``` → first-`{`-to-last-`}` substring → fail). Replicate verbatim for `validateLensVerdict(rawText)`:
```ts
// grounding-critic.ts:40-88 (abridged)
export function validateGroundingVerdict(rawText: string): ValidateGroundingResult {
  let parsed: unknown;
  try { parsed = JSON.parse(rawText.trim()); }
  catch {
    const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(rawText);
    if (fenceMatch) { try { parsed = JSON.parse(fenceMatch[1].trim()); } catch { /* fall through */ } }
    if (!parsed) {
      const braceStart = rawText.indexOf("{"); const braceEnd = rawText.lastIndexOf("}");
      if (braceStart !== -1 && braceEnd > braceStart) {
        try { parsed = JSON.parse(rawText.slice(braceStart, braceEnd + 1)); }
        catch { return { ok: false, error: `No valid JSON object found...` }; }
      } else { return { ok: false, error: `No JSON object found...` }; }
    }
  }
  const result = LensVerdictSchema.safeParse(parsed);   // <- your schema
  if (!result.success) { return { ok: false, error: /* issues */ }; }
  return { ok: true, verdict: result.data };
}
```
**Rule:** `validateLensVerdict` returns a result union and NEVER throws. The Zod schema is `{ verdict: z.enum(["approve","reject"]), feedback: z.string(), veto: z.boolean().optional() }` (only the contraindication-checker populates `veto`). Mirror `GroundingVerdictSchema` at `grounding-critic.ts:27-30`.

### Pattern B — Per-lens call loop, FAIL-CLOSED on parse exhaustion (INVERT critic-deep)
**Source (the model to MIRROR):** `src/medical/retrieval/grounding-critic.ts:170-207` — loops `GROUNDING_MAX_LLM_CALLS` attempts, returns the parsed verdict on success, and on exhaustion returns `{ verdict: "reject", feedback: "<unparseable critic output>" }` (line 203-206).
**Source (the anti-pattern to INVERT):** `src/fleet/critic-deep.ts:204-206` returns `{ verdict: "approve", feedback: "" }` on exhaustion (fail-OPEN). **Do NOT copy this.**
```ts
// grounding-critic.ts:203-206 — the fail-closed return you MUST mirror
// FAIL-CLOSED inversion of critic-deep.ts:199-201 (which returns approve on exhaustion).
// bober: reject on parse exhaustion; intentional for medical safety.
return { verdict: "reject", feedback: "<unparseable critic output>" };
```
**Rule:** `getLensVerdict` (per-lens) returns `{verdict:'reject', veto:false}` when all parse attempts fail. Carry the inversion comment.

### Pattern C — Budget constant as a closed-form expression (NOT a magic number)
**Source:** `src/medical/retrieval/grounding-critic.ts:8-9` and `src/fleet/critic-deep.ts:18-23`.
```ts
// grounding-critic.ts:8-9
export const GROUNDING_PARSE_MAX_RETRIES = 1;
export const GROUNDING_MAX_LLM_CALLS = 1 + GROUNDING_PARSE_MAX_RETRIES;

// critic-deep.ts:21-23 — budget derived from round + retry constants
export const DEEP_CRITIQUE_MAX_TOTAL_CALLS =
  DEEP_MAX_TOTAL_CALLS +
  CRITIQUE_MAX_ROUNDS * ((1 + CRITIQUE_PARSE_MAX_RETRIES) + (1 + DEEP_EXPAND_MAX_RETRIES));
```
**Rule (this sprint):**
```ts
export const LENS_PARSE_MAX_RETRIES = 1;
export const LENS_MAX_LLM_CALLS = 1 + LENS_PARSE_MAX_RETRIES;        // = 2 (mirror grounding-critic)
export const MEDICAL_PANEL_MAX_ROUNDS = 3;                           // research §4a:192
// per round = 1 generateCandidate + 4 lenses * LENS_MAX_LLM_CALLS
export const MEDICAL_PANEL_MAX_TOTAL_CALLS =
  MEDICAL_PANEL_MAX_ROUNDS * (1 + 4 * LENS_MAX_LLM_CALLS);           // = 3 * (1 + 8) = 27
```
A stopCondition + evaluatorNote require a test asserting the worst-case loop never exceeds `MEDICAL_PANEL_MAX_TOTAL_CALLS`. Count: generateCandidate invocations + total lens `chat` calls across all rounds ≤ 27.

### Pattern D — Regenerate-on-reject loop skeleton (INVERT accept-best → fail-closed)
**Source:** `src/fleet/critic-deep.ts:211-278` (`runCritiqueLoop`). Reuse the STRUCTURE: a bounded `while`/`for` over rounds, `try/catch` around each model call (a throw breaks/degrades but never propagates), feedback folded into the next regenerate. **REPLACE** its accept-best/fail-open tail (`critic-deep.ts:274-277`) with: after `maxRounds` without consensus → `{ accepted:false, reason:'no-consensus', dissent, verdicts, rounds }`.
```ts
// critic-deep.ts:237-271 — loop skeleton to adapt (NOTE the fail-open break you must replace)
while (continueLoop) {
  let verdict;
  try { verdict = await getCriticVerdict({...}); }
  catch { break; }                       // <- critic-deep: degrade. YOU: count lens-throw as reject
  if (verdict.verdict === "approve") return current;   // accept
  if (reExpandsLeft <= 0) break;         // <- exhaustion: critic-deep accept-best; YOU: fail-closed
  reExpandsLeft -= 1;
  current = await input.expand({ ..., critiqueFeedback: verdict.feedback });  // regenerate w/ feedback
}
```
**Rule:** loop generates a candidate, runs all four lenses (each its own injected client, each wrapped in `try/catch` — a throw counts as a `reject` verdict, fail-closed), reconciles, returns on accept; on reject regenerate with collected dissent feedback up to `maxRounds`.

### Pattern E — Red-flag short-circuit fires FIRST via an injected guard
**Source:** `src/medical/guardrails.ts:84-111` (`MedicalGuardrails.evaluate`) and the verdict union `src/medical/types.ts:11-14`.
```ts
// src/medical/types.ts:11-14
export type GuardrailVerdict =
  | { kind: "allow" }
  | { kind: "short-circuit"; rule: string; cannedResponse: string }
  | { kind: "refuse"; rule: string; reason: string };

// src/medical/guardrails.ts:84-111 — evaluate(prompt, ctx): GuardrailVerdict
evaluate(prompt: string, _ctx: GuardrailContext): GuardrailVerdict {
  const match = this.detector.detect(prompt);
  if (match.category !== "none")
    return { kind: "short-circuit", rule: match.ruleId ?? match.category, cannedResponse: escalationFor(match.category) };
  const r = this.refusal.detect(prompt);
  if (r.category !== "none")
    return { kind: "refuse", rule: r.ruleId ?? r.category, reason: REFUSAL_REASONS[r.category] };
  return { kind: "allow" };
}
```
**Rule:** Inject a guard of type `GuardrailSet` (`src/medical/types.ts:25-28`, the interface `MedicalGuardrails` already implements). In `runJudgeLoop`, call `redFlag.evaluate(question, ctx)` **before** `generateCandidate`. If `kind === "short-circuit"` return `{ outcome:'short-circuit', ... }`; if `kind === "refuse"` return `{ outcome:'refuse', ... }`; only on `kind === "allow"` proceed to the loop. Injecting `GuardrailSet` (not the concrete class) keeps sprint 2 fake-only and lets sprint 3 pass the real `MedicalGuardrails`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `validateGroundingVerdict` | `src/medical/retrieval/grounding-critic.ts:40` | `(rawText: string) => {ok:true;verdict} \| {ok:false;error}` | Reference never-throwing JSON-verdict parser — COPY its extraction strategy (do not import; add `veto`). |
| `GroundingVerdictSchema` | `src/medical/retrieval/grounding-critic.ts:27` | `z.object({verdict:enum,feedback:string})` | Zod schema template for your `LensVerdictSchema`. |
| `getGroundingVerdict` | `src/medical/retrieval/grounding-critic.ts:170` | `async (input) => GroundingVerdict` | Reference per-call retry loop w/ fail-closed tail (line 206). |
| `runCritiqueLoop` | `src/fleet/critic-deep.ts:211` | `async (input) => FleetManifest` | Reference regenerate-on-reject loop structure (INVERT its accept-best tail). |
| `getCriticVerdict` | `src/fleet/critic-deep.ts:171` | `async (input) => CritiqueVerdict` | The FAIL-OPEN anti-pattern at line 206 — DO NOT replicate. |
| `MedicalGuardrails.evaluate` | `src/medical/guardrails.ts:84` | `(prompt:string, ctx:GuardrailContext) => GuardrailVerdict` | Red-flag short-circuit guard; inject its `GuardrailSet` interface. |
| `GuardrailSet` (interface) | `src/medical/types.ts:25` | `{ evaluate(prompt,ctx):GuardrailVerdict; rulesetVersion:string }` | Type for the injected `redFlag` guard param. |
| `GuardrailVerdict` (type) | `src/medical/types.ts:11` | discriminated union (`allow`/`short-circuit`/`refuse`) | Reuse — do not redefine the guard verdict. |
| `LLMClient` (interface) | `src/providers/types.ts:234` | `{ chat(params:ChatParams):Promise<ChatResponse> }` | The type each injected fake lens client implements. |
| `ChatParams` / `ChatResponse` | `src/providers/types.ts:139` / `:212` | see §4 | Request/response shapes; fakes return `ChatResponse`. |
| `MedicalFinding` (type) | `src/medical/analysis/finding.ts:36` | interface (id, domain, kind, urgency, severity, …) | Sprint 3 emits Findings — DO NOT redefine or import here; sprint 2 produces verdicts/outcomes only. |

**Utilities reviewed:** `src/utils/` (`fs.ts` — only `ensureDir`/`findProjectRoot`, not needed: this sprint touches no fs), `src/medical/retrieval/`, `src/fleet/`, `src/medical/` root — relevant ones tabled above; fs/network/store utils intentionally excluded (NonGoal: no fs/network/FactStore).

---

## 4. The LLMClient interface a fake must satisfy

**Source:** `src/providers/types.ts:234-240`, `:139-202`, `:212-224`, `:128-132`.
```ts
// types.ts:234-240
export interface LLMClient { chat(params: ChatParams): Promise<ChatResponse>; }

// types.ts:139-183 (the fields you actually set: model, system, messages, jsonObjectMode)
export interface ChatParams {
  model: string; system: string; messages: Message[];
  tools?: ToolDef[]; maxTokens?: number;
  effort?: "low"|"medium"|"high"|"xhigh"|"max";
  responseSchema?: JsonSchemaObject; jsonObjectMode?: boolean;
  documents?: { base64: string; mediaType: string }[];
}
// types.ts:212-224
export interface ChatResponse {
  text: string; toolCalls: ToolCall[]; stopReason: StopReason;
  usage: { inputTokens: number; outputTokens: number };
}
// types.ts:128-132 — Message union; TextMessage is { role:"user"|"assistant"; content:string }
```
A minimal fake lens client = an object `{ async chat(p): Promise<ChatResponse> { return { text, toolCalls: [], stopReason: "end", usage: { inputTokens: 0, outputTokens: 0 } }; } }`. Lens calls should set `jsonObjectMode: true` (mirrors `grounding-critic.ts:162` and `critic-deep.ts:163`), never `responseSchema` (DeepSeek/local-model compatible).

**Each lens is a SEPARATE client** (assumption in contract: sprint 3 assigns a different model per lens via tier-policy). Recommended injected shape: a record so each lens carries its own client + model, e.g.
```ts
export interface LensSpec { client: LLMClient; model: string; }
export interface LensClients {
  evidenceGrader: LensSpec;
  contraindicationChecker: LensSpec;   // the only one whose verdict may carry veto
  conservativeClinician: LensSpec;
  optimizationLens: LensSpec;
}
```
The four lens names (exact, research §4a:186-191): **evidence-grader**, **contraindication-checker** (VETO power), **conservative-clinician**, **optimization-lens**.

---

## 5. Prior Sprint Output

### Sprint 1 (commit 307e5e7): `src/medical/analysis/`
- **Created:** `src/medical/analysis/finding.ts` — exports `MedicalFinding` (interface, line 36), `findingId(domain,biomarker,ruleKey)` (line 65), `serializeFindingToMarkdown(finding)` (line 83), plus `FindingKind`/`FindingStatus` types.
- **Created:** `review-pass.ts` (`runProactiveReview`), `trends.ts` (`analyzeTrends`), `finding-writer.ts` (`writeFinding`/`writeDashboard`).
- **Connection to this sprint:** NONE structural. Sprint 2 produces verdicts/outcomes only — it does NOT emit, import, or redefine `MedicalFinding` (Finding emission is sprint 3, NonGoal in this contract). Do not couple `judge-panel.ts` to `finding.ts`.

### Reusable substrate from earlier specs (medical/fleet)
- `src/medical/guardrails.ts` (`MedicalGuardrails`, spec-20260617-medical-whoop-guardrails) — the red-flag guard. Inject via its `GuardrailSet` interface.
- `src/medical/retrieval/grounding-critic.ts` (spec-20260618-medical-grounding-critic) — the fail-closed validator/loop reference model.
- `src/fleet/critic-deep.ts` (spec-20260618-fleet-expand-deep-critique) — the fail-OPEN loop to invert.

---

## 6. Testing Patterns

**Runner:** Vitest. **Assertion style:** `expect(...)`. **Mock approach:** hand-rolled `class ... implements LLMClient` fakes + `vi.fn()` spies (no module mocking needed — everything is injected). **File naming:** `<module>.test.ts` collocated next to source. **Location:** co-located in `src/medical/recommend/`.

### Unit Test Pattern — scripted fake client + budget assertions
**Source:** `src/medical/retrieval/grounding-critic.test.ts:15-25`, `:49-59`, `:124-139`, `:190-212`, `:272-289`.
```ts
// grounding-critic.test.ts:15-25 — ScriptedClient: canned responses in order, records every call
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
```ts
// grounding-critic.test.ts:49-59 — never-throws over many inputs (use for validateLensVerdict)
describe("validateLensVerdict never throws", () => {
  it.each([VALID_APPROVE, "```json\n{...}\n```", "", "garbage", "{}"])(
    "does not throw for %j", (input) => { expect(() => validateLensVerdict(input)).not.toThrow(); });
});
```
```ts
// grounding-critic.test.ts:272-289 — a client that THROWS on chat (use for sc-2-7 fail-closed)
const errorClient: LLMClient = {
  async chat(_p: ChatParams): Promise<ChatResponse> { throw new Error("Network timeout"); },
};
// NOTE: grounding-critic PROPAGATES the throw (rejects.toThrow). Your runJudgeLoop must NOT:
// wrap each lens call in try/catch → map throw to a reject verdict → loop RESOLVES (sc-2-7).
```
```ts
// grounding-critic.test.ts:199 / critic-deep.test.ts:108-119 — budget-cap assertion style
expect(client.calls).toHaveLength(GROUNDING_MAX_LLM_CALLS);            // exact call count
expect(MEDICAL_PANEL_MAX_TOTAL_CALLS).toBe(MEDICAL_PANEL_MAX_ROUNDS * (1 + 4 * LENS_MAX_LLM_CALLS));
```

### Spy never-called pattern (for sc-2-5: red-flag fires before generateCandidate)
**Source:** project uses `vi.fn()` spies + `toHaveBeenCalled` assertions — `src/medical/inference.test.ts:19-20`, `:65` (`toHaveBeenCalledTimes(1)`), `:56`/`:93` (`not.toHaveBeenCalledWith`).
```ts
import { vi, expect } from "vitest";
const generateCandidate = vi.fn(async (_prevFeedback?: string) => ({ /* candidate */ }));
const redFlag: GuardrailSet = {
  rulesetVersion: "test",
  evaluate: () => ({ kind: "short-circuit", rule: "cardiac", cannedResponse: "Call 911" }),
};
const outcome = await runJudgeLoop({ question: "chest pain", generateCandidate, lensClients, redFlag, ... });
expect(outcome.outcome).toBe("short-circuit");
expect(generateCandidate).not.toHaveBeenCalled();   // <- sc-2-5
```

### Concrete fakes for the seven success criteria
- **sc-2-2** (all approve, no veto → accepted, rounds=1): 4 lens clients each scripted `'{"verdict":"approve","feedback":""}'`; assert `accepted===true`, `rounds===1`, `generateCandidate` called once.
- **sc-2-3** (veto overrides): contraindication client returns `'{"verdict":"approve","veto":true,"feedback":"interacts w/ med X"}'`, other three approve → `accepted===false`, `reason==='contraindication-veto'`.
- **sc-2-4** (2 approve / 2 reject tie): → `accepted===false` (fail-closed on tie).
- **sc-2-5** (red-flag): see spy pattern above.
- **sc-2-6** (reject every round): all lenses reject every round → loop stops at `maxRounds`, `accepted===false`, `reason==='no-consensus'`, `dissent` has per-lens feedback strings.
- **sc-2-7** (lens throws): one lens client `{ async chat() { throw new Error("boom"); } }` → that lens counts as reject, `runJudgeLoop` resolves (no throw). Use `await expect(runJudgeLoop(...)).resolves.toBeDefined()`.
- **budget**: script all-reject and assert total `chat` calls + generate calls ≤ `MEDICAL_PANEL_MAX_TOTAL_CALLS`.

### E2E
Not applicable — pure orchestration module, unit tests only.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| (none) | `src/medical/recommend/*` | **none** | All five files are NEW; nothing imports `recommend/` yet. Sprint 3 will be the first consumer. Zero existing dependents. |

This is purely additive — no existing file is modified. The only cross-module reads are TYPE imports FROM existing stable files (`providers/types.ts`, `medical/types.ts`), which are unchanged.

### Existing Tests That Must Still Pass
No existing test exercises `recommend/`. Guard against accidental coupling:
- `src/medical/retrieval/grounding-critic.test.ts` — must stay green (you copy its validator pattern but DO NOT edit the file).
- `src/fleet/critic-deep.test.ts` — must stay green (you reference, not modify, `critic-deep.ts`).
- `src/medical/guardrails.*` and `src/medical/types.ts` — if you import `GuardrailSet`/`GuardrailVerdict`, do NOT change those files; type-only import keeps every existing test byte-identical.

### Features That Could Be Affected
- **Sprint 3 (same spec)** consumes `runJudgeLoop` + assigns per-lens models via tier-policy + assembles the real profile context from FactStore + emits `MedicalFinding`. Keep the injected-param surface (`generateCandidate`, `lensClients` w/ per-lens `model`, `redFlag` guard, `context`, `now`, `maxRounds`) clean and provider-agnostic so sprint 3 wires real clients without refactor.

### Recommended Regression Checks (run after implementation)
1. `npm run build` (tsc) — zero type errors (sc-2-1).
2. `npx vitest run src/medical/recommend` — all new sc-2-2…sc-2-7 + budget tests pass.
3. `npx vitest run src/medical src/fleet` — confirm no collateral breakage in sibling medical/fleet suites.
4. Grep guard: `grep -rn "node:fs\|createClient\|fetch(\|FactStore" src/medical/recommend` returns NOTHING (evaluatorNote: no provider factory, no fs, no network).
5. Confirm the inversion comment referencing `grounding-critic.ts` vs `critic-deep.ts` exists in the new code (evaluatorNote).

---

## 8. Implementation Sequence (dependency-ordered)

1. **`src/medical/recommend/types.ts`** — define `LensName` union, `LensVerdict` (`{verdict:'approve'|'reject'; feedback:string; veto?:boolean}`), `LensSpec`/`LensClients`, `PanelDecision` (`{accepted:boolean; reason?:'contraindication-veto'|'no-consensus'}`), the `PanelOutcome` discriminated union (`{outcome:'short-circuit'|'refuse'}` | `{accepted:true; recommendation; verdicts; rounds}` | `{accepted:false; reason; dissent; verdicts; rounds}`), and the budget constants (`LENS_PARSE_MAX_RETRIES`, `LENS_MAX_LLM_CALLS`, `MEDICAL_PANEL_MAX_ROUNDS`, `MEDICAL_PANEL_MAX_TOTAL_CALLS`).
   - Verify: `tsc --noEmit` clean; no value imports, types only.
2. **`src/medical/recommend/lenses.ts`** — `LensVerdictSchema` (Zod, with optional `veto`), `validateLensVerdict(rawText)` (copy `grounding-critic.ts:40-88`), four `buildXSystemPrompt(...)` (each lens its own focus instruction; contraindication-checker prompt MUST instruct the model to emit `veto:boolean`), the coercion-instruction constant, an internal `callLens` (fresh message array, `jsonObjectMode:true`, 3-message coercion shape on retry — mirror `grounding-critic.ts:123-166`), and `getLensVerdict({client,model,...})` looping `LENS_MAX_LLM_CALLS` with FAIL-CLOSED `{verdict:'reject',veto:false}` on exhaustion (carry the inversion comment).
   - Verify: `lenses.test.ts` — `validateLensVerdict` never throws over the `it.each` set; veto parses only on the contraindication schema; exhaustion → reject.
3. **`src/medical/recommend/judge-panel.ts`** — `reconcilePanel(verdicts)` first: **any `veto===true` → `{accepted:false, reason:'contraindication-veto'}` (checked BEFORE the vote)**, else `approveCount > rejectCount ? {accepted:true} : {accepted:false, reason:'no-consensus'}` (tie → not accepted). Then `runJudgeLoop({question, generateCandidate, lensClients, context, redFlag, now, maxRounds=MEDICAL_PANEL_MAX_ROUNDS})`: (1) `redFlag.evaluate(question, ctx)` FIRST → return short-circuit/refuse before `generateCandidate`; (2) loop ≤ maxRounds: `candidate = await generateCandidate(prevFeedback?)`, run all four lenses each `try/catch` (throw → reject verdict w/ a `feedback` note), `reconcilePanel`, return accept; (3) post-loop → `{accepted:false, reason, dissent, verdicts, rounds}`. Never throw; never exceed `MEDICAL_PANEL_MAX_TOTAL_CALLS`.
   - Verify: `judge-panel.test.ts` covers sc-2-2…sc-2-7 + budget cap.
4. **Tests** (`lenses.test.ts`, `judge-panel.test.ts`) — collocate; use `ScriptedClient`, throwing client, `vi.fn()` generateCandidate spy, fake `GuardrailSet`.
   - Verify: `npx vitest run src/medical/recommend`.
5. **Full verification** — `npm run build` (sc-2-1) + `npx vitest run src/medical/recommend src/medical src/fleet` + the grep guard from §7.

---

## 9. Pitfalls & Warnings

- **Veto-before-vote ordering (HIGHEST RISK).** In `reconcilePanel`, the veto check MUST come BEFORE the majority count. If you compute `approveCount > rejectCount` first and return early, a 3-approve/1-veto case wrongly accepts. Test sc-2-3 catches exactly this. NonGoal #4: no code path may let a vote majority override a veto.
- **Fail-OPEN copy-paste trap.** `critic-deep.ts:206` (`return {verdict:"approve"}`) and `critic-deep.ts:274-277` (accept-best) are the WRONG tail. If you adapt `runCritiqueLoop` you will copy its fail-open tail by reflex — INVERT it. Mirror `grounding-critic.ts:206` instead. Evaluator checks for the `grounding-critic.ts` vs `critic-deep.ts` inversion comment.
- **Throw must NOT propagate.** `grounding-critic.ts` deliberately PROPAGATES transport throws (test at `grounding-critic.test.ts:272-289` asserts `rejects.toThrow`). Your `runJudgeLoop` does the OPPOSITE: wrap each lens `chat` in `try/catch`, map a throw to a `reject` verdict, and RESOLVE (sc-2-7). Do not let one lens's throw reject the whole promise.
- **`.js` import extensions** are mandatory under NodeNext ESM. `import type { LLMClient } from "../../providers/types.js"`, `import type { GuardrailSet, GuardrailVerdict } from "../types.js"`. Omitting `.js` fails the build (sc-2-1).
- **No fs / network / provider / FactStore** (NonGoal). Do not `import { createClient }` from providers, no `node:fs`, no `HealthDataStore`/FactStore. Everything (`generateCandidate`, `lensClients`, `redFlag`, `context`) is an injected parameter. Evaluator greps for this.
- **Do not redefine `MedicalFinding`** (`finding.ts:36`) and do not emit Findings — that is sprint 3 (NonGoal #2). Sprint 2 returns verdicts/outcomes only. The `recommendation` carried on an accepted outcome is the raw injected candidate, NOT a Finding.
- **Reuse `GuardrailVerdict`/`GuardrailSet`** from `src/medical/types.ts:11-28`; do not invent a parallel guard verdict type. Inject the interface (not the concrete `MedicalGuardrails`) so the module stays fake-only.
- **`jsonObjectMode:true`, never `responseSchema`** on lens calls (mirror `grounding-critic.ts:162`, `critic-deep.ts:163`) — `responseSchema` is rejected by DeepSeek/local models that sprint 3 may route lenses to.
- **Budget as a derived constant, not a literal.** Tests assert `MEDICAL_PANEL_MAX_TOTAL_CALLS` equals the closed-form (`grounding-critic.test.ts:137-139` style). A hardcoded `27` will read as a magic number and drift from the round/retry constants.
