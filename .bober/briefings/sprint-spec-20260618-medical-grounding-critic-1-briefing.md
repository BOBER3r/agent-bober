# Sprint Briefing: Grounding-critic module (fail-closed core)

**Contract:** sprint-spec-20260618-medical-grounding-critic-1
**Generated:** 2026-06-18T16:30:00Z

> Sprint 1 of 3. Build ONE standalone module + its collocated test. NO engine wiring, NO config, NO re-synthesis loop (those are Sprints 2 & 3). The module is **pure given an injected LLMClient**. The single behavioral novelty vs. the fleet critic it copies: the parse-exhaustion default flips from `approve` (fail-OPEN) to `reject` (fail-CLOSED).

---

## 1. Target Files

### `src/medical/retrieval/grounding-critic.ts` (create)

**Directory pattern:** files in `src/medical/retrieval/` use **kebab-case** names (`medline-source.ts`, `literature.ts`) with collocated `*.test.ts`. ESM `.js` import extensions, unicode box-drawing section headers (`// ── Section ──────`), `import type { ... }` for type-only imports.

**Most similar existing file (COPY ITS STRUCTURE):** `src/fleet/critic-deep.ts` — the new module is a near-mechanical structural copy of its lines 54-202, with ONE inverted branch.

**Required exports (per contract definitionOfDone + generatorNotes):**
- `GROUNDING_PARSE_MAX_RETRIES = 1`
- `GROUNDING_MAX_LLM_CALLS = 1 + GROUNDING_PARSE_MAX_RETRIES` (= 2)
- `GroundingVerdictSchema` (zod)
- `GroundingVerdict` (type = `z.infer<typeof GroundingVerdictSchema>`)
- `validateGroundingVerdict(rawText: string)` — **NEVER throws**; returns `{ok:true,verdict}|{ok:false,error}`
- `buildGroundingSystemPrompt(question, answerBody, passages: Passage[]): string`
- `getGroundingVerdict({ llm, model, question, answerBody, passages })` — bounded loop, **fail-CLOSED reject** on exhaustion

**Imports the new file will need:**
```ts
import { z } from "zod";
import type { LLMClient, Message } from "../../providers/types.js";  // NOTE: two levels up (retrieval/ → medical/ → src/)
import type { Passage } from "./medline-source.js";
```
(The fleet critic uses `"../providers/types.js"` because `src/fleet/` is one level down; from `src/medical/retrieval/` it is `"../../providers/types.js"`.)

**Imported by:** NOTHING. Verified via `grep -rn "grounding-critic" src/` → zero hits. Blast radius = the two new files only. Sprint 2 will be the first importer.

**Test file:** `src/medical/retrieval/grounding-critic.test.ts` (create — collocated, per principles.md:20).

---

### `src/medical/retrieval/grounding-critic.test.ts` (create)

**Structure template:** collocated vitest test. Two valid fake-LLMClient styles exist in this repo (see §6). For this sprint, prefer a recording **ScriptedClient** (queue strings, record `ChatParams[]`) — it is exactly what the success criteria need (queued responses + `chat.mock.calls`/`.calls` inspection).

---

## 2. Patterns to Follow

### Pattern A — The tolerant never-throws parser (COPY STRUCTURALLY)
**Source:** `src/fleet/critic-deep.ts`, lines 67-115 (`validateVerdict`).
```ts
export function validateGroundingVerdict(rawText: string): ValidateGroundingResult {
  let parsed: unknown;

  // Try direct parse first
  try {
    parsed = JSON.parse(rawText.trim());
  } catch {
    // Try extracting JSON from markdown code fences
    const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(rawText);
    if (fenceMatch) {
      try { parsed = JSON.parse(fenceMatch[1].trim()); } catch { /* fall through */ }
    }
    // Try finding the first { ... } block
    if (!parsed) {
      const braceStart = rawText.indexOf("{");
      const braceEnd = rawText.lastIndexOf("}");
      if (braceStart !== -1 && braceEnd > braceStart) {
        try { parsed = JSON.parse(rawText.slice(braceStart, braceEnd + 1)); }
        catch { return { ok: false, error: `No valid JSON object found in response. Raw: ${rawText.slice(0, 200)}` }; }
      } else {
        return { ok: false, error: `No JSON object found in response. Raw: ${rawText.slice(0, 200)}` };
      }
    }
  }

  const result = GroundingVerdictSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    return { ok: false, error: issues };
  }
  return { ok: true, verdict: result.data };
}
```
**Rule:** Every path returns a result object — `JSON.parse`, fence-regex, brace-slice, and `safeParse` are all wrapped. Never `throw`. The `{}` (empty object) case naturally returns `ok:false` because `safeParse` rejects (missing `verdict`/`feedback`) — confirmed by the fleet test `validateVerdict("{}").ok === false` (critic-deep.test.ts:198-200).

### Pattern B — Schema + types (COPY)
**Source:** `src/fleet/critic-deep.ts`, lines 54-63.
```ts
export const GroundingVerdictSchema = z.object({
  verdict: z.enum(["approve", "reject"]),
  feedback: z.string(),
});
export type GroundingVerdict = z.infer<typeof GroundingVerdictSchema>;
export type ValidateGroundingResult =
  | { ok: true; verdict: GroundingVerdict }
  | { ok: false; error: string };
```
**Rule:** Same shape as fleet `CritiqueVerdict`. `verdict` is the enum `["approve","reject"]`, `feedback` is a required string (empty string allowed for approve).

### Pattern C — Constants block with unicode section header
**Source:** `src/fleet/critic-deep.ts`, lines 11-18.
```ts
// ── Constants ────────────────────────────────────────────────────────
export const GROUNDING_PARSE_MAX_RETRIES = 1;
export const GROUNDING_MAX_LLM_CALLS = 1 + GROUNDING_PARSE_MAX_RETRIES;
```
**Rule:** Unicode box-drawing section headers per principles.md:32. Derive the call budget from the retry constant (do NOT hard-code `2`) so the relation is auditable — mirrors how the fleet derives `DEEP_CRITIQUE_MAX_TOTAL_CALLS` (critic-deep.ts:16-18).

### Pattern D — Fresh message array (the LOCK1 invariant) + coercion retry shape (COPY, adapt content)
**Source:** `src/fleet/critic-deep.ts`, lines 119-162 (`callCritic`).
```ts
// ── Internal: one grounding-critic call ──────────────────────────────
async function callGroundingCritic(input: {
  llm: LLMClient;
  model: string;
  question: string;
  answerBody: string;
  passages: Passage[];
  priorText?: string;
  formattedError?: string;
}): Promise<string> {
  const { llm, model, question, answerBody, passages, priorText, formattedError } = input;

  // Fresh message array — NEVER extends the prior synthesis conversation (LOCK1)
  const firstUserContent =
    `Review this answer as an independent reviewer.\n\n` +
    `Question: ${question}\n\n` +
    `Answer to review:\n${answerBody}\n\n` +
    `Cited passages:\n${formatPassageBlock(passages)}`;   // numbered block — see Pattern E

  let messages: Message[];
  if (priorText !== undefined && formattedError !== undefined) {
    // Coercion retry: 3-message shape [user, assistant, user]
    messages = [
      { role: "user", content: firstUserContent },
      { role: "assistant", content: priorText },
      { role: "user", content: `${GROUNDING_COERCION_INSTRUCTION}\n\nPrevious validation error:\n${formattedError}` },
    ];
  } else {
    messages = [{ role: "user", content: firstUserContent }];
  }

  const response = await llm.chat({ model, system: buildGroundingSystemPrompt(question, answerBody, passages), messages, jsonObjectMode: true });
  return response.text;
}
```
**Rule (LOCK1, critic-deep.ts:130):** The critic ALWAYS starts from a brand-new message array containing the question, the answer body, and the cited passages — it must NEVER include a prior synthesis assistant turn. The first attempt is exactly `[{role:"user", ...}]` (length 1). The coercion retry is exactly the 3-message `[user, assistant(priorText), user(coercion+error)]` shape. **Do NOT catch transport errors here** — let `llm.chat` rejections propagate (generatorNotes: Sprint 2's orchestrator maps a throw to abstain; this module's responsibility stays narrow).

> Note on system prompt placement: the contract's `buildGroundingSystemPrompt(question, answerBody, passages)` signature includes the passages in the SYSTEM prompt (mirroring `buildSynthesisSystem`, Pattern E). The first USER message ALSO restates question + answer + a `Cited passages:` block, because sc-1-5 / evaluatorNotes assert that `messages[0].content` contains a passage title/url AND the answer body. Put the numbered passage block in BOTH the system prompt and the first user message so both assertions hold. The simplest correct move: reuse the same `formatPassageBlock(passages)` helper in both.

### Pattern E — Numbered passage block format (MATCH EXACTLY)
**Source:** `src/medical/retrieval/literature.ts`, lines 54-67 (`buildSynthesisSystem`).
```ts
const passageBlock = passages
  .map((p, i) => `[${i + 1}] ${p.title}\n${p.text}\nSource: ${p.url}`)
  .join("\n\n");
```
**Rule:** Use the identical `[n] title \n text \n Source: url` numbered format the synthesizer uses, so the critic sees passages in the same shape they were grounded in. Factor it into a small `formatPassageBlock(passages: Passage[]): string` helper and call it from both `buildGroundingSystemPrompt` and `callGroundingCritic`. The block must surface `p.title` and `p.url` (evaluatorNotes sc-1-5 asserts the user message "includes a passage title/url").

### Pattern F — Bounded retry loop with the FAIL-CLOSED inversion
**Source:** `src/fleet/critic-deep.ts`, lines 166-202 (`getCriticVerdict`). The ONLY behavioral change is the final return.
```ts
// ── getGroundingVerdict (FAIL-CLOSED on parse exhaustion) ────────────
export async function getGroundingVerdict(input: {
  llm: LLMClient;
  model: string;
  question: string;
  answerBody: string;
  passages: Passage[];
}): Promise<GroundingVerdict> {
  const { llm, model, question, answerBody, passages } = input;
  const maxAttempts = GROUNDING_MAX_LLM_CALLS;   // = 1 + GROUNDING_PARSE_MAX_RETRIES

  let lastError = "Unknown error";
  let priorText: string | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const rawText = await callGroundingCritic({
      llm, model, question, answerBody, passages,
      priorText: attempt > 0 ? priorText : undefined,
      formattedError: attempt > 0 ? lastError : undefined,
    });
    const validated = validateGroundingVerdict(rawText);
    if (validated.ok) {
      return validated.verdict;
    }
    lastError = validated.error;
    priorText = rawText;
  }

  // FAIL-CLOSED inversion of critic-deep.ts:199-201 (which returns approve).
  return { verdict: "reject", feedback: "<unparseable critic output>" };
}
```
**Rule:** `critic-deep.ts:199-201` returns `{ verdict: "approve", feedback: "" }` (fail-OPEN). Here you MUST return `{ verdict: "reject", feedback: "<unparseable critic output>" }` (fail-CLOSED). This single line is the whole point of the sprint (sc-1-4). `approve` may be returned ONLY when the model explicitly emits a parseable approve verdict.

### Pattern G — A coercion-instruction constant (adapt from fleet)
**Source:** `src/fleet/critic-deep.ts`, lines 40-50 (`CRITIQUE_COERCION_INSTRUCTION`).
**Rule:** Define a `GROUNDING_COERCION_INSTRUCTION` string that re-states "output ONLY a JSON object `{verdict,feedback}`" for the retry turn. Used in the 3-message coercion path (Pattern D).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `Passage` (type) | `src/medical/retrieval/medline-source.ts:12-17` | `{ title; url; text; source:"medlineplus" }` | The passage shape the critic receives — IMPORT it, don't redefine. |
| `RetrievalOutcome` (type) | `src/medical/retrieval/medline-source.ts:25-28` | discriminated `disabled\|abstain\|grounded{passages}` | Sprint 2 input; not needed by this sprint's module but useful context. |
| `LLMClient` (type) | `src/providers/types.ts:216-222` | `{ chat(params: ChatParams): Promise<ChatResponse> }` | The injected client — IMPORT as `import type`. |
| `Message` (type) | `src/providers/types.ts:128-132` | union incl. `TextMessage {role:"user"\|"assistant"; content}` | The `messages[]` element type — IMPORT as `import type`. |
| `ChatParams` (type) | `src/providers/types.ts:139-184` | `{ model; system; messages; jsonObjectMode?; maxTokens?; ... }` | Shape `llm.chat({...})` is called with. `jsonObjectMode:true` is the field to set. |
| `ChatResponse` (type) | `src/providers/types.ts:194-206` | `{ text; toolCalls; stopReason; usage }` | Response shape — read `.text`. |
| `MedicalAnswer` / `Citation` (types) | `src/medical/types.ts:33-46` | `MedicalAnswer{body,abstained,citations,...}` | Sprint 2 wiring uses these; NOT needed inside this sprint's module (it judges raw `answerBody:string` + `passages`). |
| `buildSynthesisSystem` (fn, private) | `src/medical/retrieval/literature.ts:54-67` | `(passages: Passage[]) => string` | Reference for the passage-block format (Pattern E). Private — copy the format, do not import. |
| `validateVerdict` / `CritiqueVerdictSchema` / `callCritic` / `getCriticVerdict` | `src/fleet/critic-deep.ts:67/54/119/166` | — | The structural templates. DO NOT import from `src/fleet` into `src/medical` — COPY the shapes into the new file (keeps the medical tree self-contained; avoids cross-module coupling). |

**Utilities reviewed:** `src/medical/` (egress, types, retrieval), `src/providers/types.ts`, `src/fleet/critic-deep.ts`, `src/utils/` (no JSON/verdict helper applies — the tolerant parser is local to each critic). No shared "tolerant JSON verdict parser" util exists; the fleet inlines its own, so inlining a copy here is the established pattern, not duplication-by-accident.

---

## 4. Prior Sprint Output

No prior sprints in this spec (`dependsOn: []`, this is Sprint 1 of 3). Relevant PRIOR-FEATURE output the module builds on (already on this branch):
- **Medical Phase 6 / Sprint 7 (literature):** `src/medical/retrieval/medline-source.ts` exports `Passage`, `RetrievalOutcome`; `src/medical/retrieval/literature.ts` exports `LiteratureRetriever`, `synthesize`. The grounding critic audits the `answerBody` that `synthesize` (literature.ts:98-177) produces against the `Passage[]` it grounded in. This sprint does NOT touch either file (nonGoals line 55).
- **Fleet decomposer Phase 4 (critique):** `src/fleet/critic-deep.ts` is the template — its fail-OPEN critic is what this module deliberately inverts.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere** — all imports use `.js` extensions (NodeNext). From `src/medical/retrieval/` the providers path is `"../../providers/types.js"` (two levels up). (principles.md:27)
- **`import type { ... }`** for type-only imports — ESLint `consistent-type-imports` is a hard gate. (principles.md:35)
- **Provider-agnostic** — all LLM interaction via `providers/types.ts`; never import an SDK. The module receives an injected `LLMClient`. (principles.md:28)
- **No SDK lock-in / no network in medical** — never import `@anthropic-ai/sdk`, `openai`, `node:net`, `node:http`, or use `fetch(`. (principles.md:41 + ESLint medical boundary below)
- **Zod for validation** — use `z.object`/`z.enum`/`safeParse`. (principles.md:29)
- **Section comments** — unicode box-drawing headers `// ── Name ──────`. (principles.md:32)
- **Collocated tests** — `grounding-critic.test.ts` next to `grounding-critic.ts`, vitest. (principles.md:20)
- **No synchronous fs** — not applicable here (no fs at all in this module). (principles.md:42)
- **Prefix unused params with `_`** — only escape for unused vars. (principles.md:36)

### Architecture Decisions
- **ADR-6 (zero-egress medical tree):** `src/medical/**/*.ts` is under a scoped ESLint `no-restricted-imports`/`no-restricted-globals` boundary (`eslint.config.js:70-98`). The boundary bans `undici/got/axios/node-fetch`, all `http/https/net/tls/dgram` (incl. `node:` prefixes), and the `fetch` global. ONLY two files are excepted (`medline-source.ts`, `whoop/whoop-client.ts` — `eslint.config.js:99-106`). **`grounding-critic.ts` is NOT excepted**, so it must contain zero network surface (it doesn't need any — it only calls the injected `llm.chat`). This is exactly sc-1-7.
- No standalone architecture doc for this critic; the contract `generatorNotes` IS the spec.

### Other Docs
None required. The contract's `generatorNotes` provides a near-complete recipe — follow it.

---

## 6. Testing Patterns

### Unit Test Pattern (RECOMMENDED for this sprint) — recording ScriptedClient
**Source:** `src/fleet/critic-deep.test.ts`, lines 28-46.
```ts
import { describe, it, expect } from "vitest";
import type { LLMClient, ChatParams, ChatResponse } from "../../providers/types.js";

/** Returns scripted responses in order; repeats the last once exhausted. Records every ChatParams. */
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
**How the fleet test asserts the exact things this sprint needs** (critic-deep.test.ts:280-303, 320-336):
```ts
// fail-closed equivalent of this (fleet asserts approve; you assert reject):
const client = new ScriptedClient(["garbage 1", "garbage 2"]);
const result = await getGroundingVerdict({ llm: client, model: "m", question: "q", answerBody: "a", passages: SAMPLE_PASSAGES });
expect(result.verdict).toBe("reject");                  // sc-1-4 FAIL-CLOSED
expect(client.calls).toHaveLength(GROUNDING_MAX_LLM_CALLS); // sc-1-6 (=2)

// fresh single-user-turn inspection (sc-1-5):
const firstMsg = client.calls[0]?.messages[0];
expect(client.calls[0]?.messages).toHaveLength(1);      // first attempt = single turn
expect(firstMsg?.role).toBe("user");
expect((firstMsg as { content: string }).content).toContain(SAMPLE_PASSAGES[0].title); // passage title present
expect((firstMsg as { content: string }).content).toContain("a");                       // answer body present
// assert NO assistant turn in the first attempt's messages:
expect(client.calls[0]?.messages.some((m) => m.role === "assistant")).toBe(false);
expect(client.calls[0]?.jsonObjectMode).toBe(true);
```
> `messages[0]` is a `TextMessage`, so `.content` is typed. If TS narrows awkwardly, cast via `as { content: string }` or guard `if (m.role === "user" && "content" in m)`. The fleet test reads `firstMsg?.content` directly (critic-deep.test.ts:234) — that compiles because `Message` union members that carry `content` make it accessible after an optional chain; prefer matching that style.

**parametrized never-throws test (sc-1-3):**
```ts
const RAW = SAMPLE_PASSAGES; // reuse below
describe("validateGroundingVerdict never throws", () => {
  it.each([
    '{"verdict":"approve","feedback":""}',
    "```json\n{\"verdict\":\"reject\",\"feedback\":\"x\"}\n```",
    'prose {"verdict":"reject","feedback":"x"} prose',
    "",
    "garbage",
    "{}",
  ])("does not throw for %j", (input) => {
    expect(() => validateGroundingVerdict(input)).not.toThrow();
  });
  it("ok:true only for valid shapes", () => {
    expect(validateGroundingVerdict('{"verdict":"approve","feedback":""}').ok).toBe(true);
    expect(validateGroundingVerdict("garbage").ok).toBe(false);
    expect(validateGroundingVerdict("{}").ok).toBe(false);
  });
});
```

### Alternative fake (medical-style vi.fn)
**Source:** `src/medical/retrieval/literature.test.ts`, lines 32-41.
```ts
function makeApproveLlm(): LLMClient {
  return { chat: vi.fn().mockResolvedValue({ text: '{"verdict":"approve","feedback":""}', toolCalls: [], stopReason: "end", usage: { inputTokens: 10, outputTokens: 5 } }) };
}
```
**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** hand-rolled `ScriptedClient implements LLMClient` (preferred — needs ordered queue + call recording) OR `{ chat: vi.fn().mockResolvedValue(...) }` (for single-response cases). With `vi.fn()` you can inspect `chat.mock.calls[0][0].messages` (per evaluatorNotes sc-1-5); with `ScriptedClient` you inspect `client.calls[0].messages`. Either is accepted by the criteria — `ScriptedClient` covers all of sc-1-3..sc-1-6 cleanly.
**File naming:** `grounding-critic.test.ts`. **Location:** collocated (same dir as source).

### E2E Test Pattern
Not applicable — no Playwright/E2E surface for a pure module. (Verified: this is a CLI/library repo, principles.md:48.)

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| (none) | `grounding-critic.ts` | **none** | `grep -rn "grounding-critic" src/` returns zero hits — nothing imports the new module. The new file is purely additive; it cannot break existing code by definition. |

The module imports type-only from `medline-source.ts` and `providers/types.ts` (no runtime coupling, no mutation). It does not modify any existing file.

### Existing Tests That Must Still Pass
This sprint adds files only, but the FULL suite must stay green (sc-1-2, no regression). The highest-signal pre-existing suites to confirm unchanged:
- `src/fleet/critic-deep.test.ts` — tests the fleet critic the new module mirrors. Confirm it STILL asserts fail-OPEN approve (critic-deep.test.ts:289) — you must NOT have edited `critic-deep.ts`.
- `src/medical/retrieval/literature.test.ts` — tests `synthesize`/`LiteratureRetriever`; shares the `Passage` type. Confirm it still passes (the new module does not touch `literature.ts`).
- `src/medical/retrieval/medline-source.test.ts` — tests the `Passage`/`RetrievalOutcome` source you import the type from.
- The whole medical tree under the ADR-6 ESLint boundary must still lint clean.

### Features That Could Be Affected
- **Medical synthesis (Phase 6):** shares `Passage` and the synthesis system-prompt format. Verify `synthesize` behavior is byte-unchanged (you only READ literature.ts for the block format; you do not edit it).
- **Fleet decomposer-deep critique (Phase 4):** shares the critic template. Verify `critic-deep.ts` is untouched (DO NOT import from it — copy shapes instead).

### Recommended Regression Checks
After implementation, the Generator MUST run:
1. `npm run build` — zero TS errors (sc-1-1).
2. `npm run typecheck` — zero strict-mode errors (sc-1-1).
3. `npm run test` — full suite green incl. new `grounding-critic.test.ts`; zero regression in `critic-deep.test.ts`, `literature.test.ts`, `medline-source.test.ts` (sc-1-2).
4. `npm run lint` — clean; specifically the medical ADR-6 boundary (sc-1-7).
5. `grep -nE "@anthropic-ai/sdk|openai|node:net|node:http|fetch\(" src/medical/retrieval/grounding-critic.ts` → MUST return nothing (sc-1-7).
6. `grep -n "grounding-critic" -r src/` → only the two new files reference it (confirms no accidental wiring; nonGoals).

---

## 8. Implementation Sequence

1. **Create `src/medical/retrieval/grounding-critic.ts` — imports + constants + schema/types.**
   - Imports: `z` from zod; `import type { LLMClient, Message }` from `"../../providers/types.js"`; `import type { Passage }` from `"./medline-source.js"`.
   - `GROUNDING_PARSE_MAX_RETRIES = 1`, `GROUNDING_MAX_LLM_CALLS = 1 + GROUNDING_PARSE_MAX_RETRIES`.
   - `GroundingVerdictSchema`, `GroundingVerdict`, `ValidateGroundingResult` (Pattern B).
   - Verify: `npx tsc --noEmit` compiles this far (no unused imports yet — keep `Message`/`Passage` until used in next steps).
2. **Add `validateGroundingVerdict` (Pattern A) — the never-throws parser.**
   - Copy critic-deep.ts:67-115 verbatim-structurally, renaming `CritiqueVerdictSchema` → `GroundingVerdictSchema`.
   - Verify: write the sc-1-3 parametrized test first; it must pass (never throws; correct `ok` for each shape including `"{}"` → false, `""` → false).
3. **Add `formatPassageBlock` + `buildGroundingSystemPrompt` (Patterns E + D-note).**
   - `formatPassageBlock(passages)` = the `[n] title \n text \n Source: url` join (literature.ts:55-57).
   - `buildGroundingSystemPrompt(question, answerBody, passages)` returns the reviewer instruction (from generatorNotes: "You are an independent reviewer… Approve ONLY if EVERY claim is directly supported… Reject if any claim is unsupported OR the answer omits the central part of the question… Output ONLY {\"verdict\":...,\"feedback\":...}") followed by the numbered passage block.
   - Verify: typecheck clean; `passages` param now consumed.
4. **Add `GROUNDING_COERCION_INSTRUCTION` + `callGroundingCritic` (Patterns G + D).**
   - Fresh single-user-turn on first attempt; 3-message `[user, assistant(priorText), user(coercion+error)]` on retry.
   - `llm.chat({ model, system: buildGroundingSystemPrompt(...), messages, jsonObjectMode: true })` — return `response.text`.
   - Do NOT wrap in try/catch (let transport errors propagate).
   - Verify: `Message` import now consumed; typecheck clean.
5. **Add `getGroundingVerdict` (Pattern F) — bounded loop with the FAIL-CLOSED inversion.**
   - `maxAttempts = GROUNDING_MAX_LLM_CALLS`; loop; return verdict on `ok`; after the loop return `{ verdict: "reject", feedback: "<unparseable critic output>" }`.
   - Verify: typecheck clean; all exports present per definitionOfDone.
6. **Create `src/medical/retrieval/grounding-critic.test.ts` (§6 patterns).**
   - Cover: never-throws (sc-1-3, parametrized), approve-only-on-explicit-approve (sc-1-4 happy), fail-closed reject on all-garbage (sc-1-4), fresh single-user-turn with passages + answer + no assistant turn (sc-1-5), call cap == `GROUNDING_MAX_LLM_CALLS` (sc-1-6), coercion 3-message shape on retry.
   - Verify: `npm run test` green for the new file.
7. **Run full verification** — `npm run build && npm run typecheck && npm run test && npm run lint`, then the two greps in §7 step 5-6. All must be clean with zero regression.

---

## 9. Pitfalls & Warnings

- **Import path depth.** `src/medical/retrieval/` is TWO levels below `src/`. Providers import is `"../../providers/types.js"` — NOT `"../providers/types.js"` (that's what `src/fleet/critic-deep.ts:2` uses because fleet is one level down). Getting this wrong = immediate module-not-found.
- **The inversion is the whole sprint (sc-1-4).** It is easy to copy `getCriticVerdict` and forget to flip the final return. critic-deep.ts:199-201 returns `approve`; you MUST return `{ verdict: "reject", feedback: "<unparseable critic output>" }`. Use that EXACT feedback string (contract + generatorNotes).
- **Do NOT import from `src/fleet/`.** Copy the parser/schema/loop SHAPES into the new file. Importing `validateVerdict`/`CritiqueVerdictSchema` from `src/fleet/critic-deep.js` would couple the medical tree to fleet and risks the fleet's fail-OPEN default leaking. The contract assumptions say "copied structurally," not imported.
- **No network surface (sc-1-7 / ADR-6).** This file is NOT in the ESLint exception list (`eslint.config.js:101`). Do not import any http/net SDK and do not call `fetch(`. The module only ever touches the injected `llm.chat`. The grep in §7 step 5 is the gate.
- **Do NOT catch transport errors in `callGroundingCritic`/`getGroundingVerdict`.** generatorNotes is explicit: let `llm.chat` rejections propagate (Sprint 2 maps a throw → abstain). Wrapping them here would silently swallow failures and break Sprint 2's contract. (Contrast with `synthesize` literature.ts:142, which DOES catch — that is Sprint 2's job, not this module's.)
- **`jsonObjectMode: true`, never `responseSchema`.** The fleet tests assert `responseSchema` is `undefined` and `jsonObjectMode === true` (critic-deep.test.ts:219-220, 314-317). Set only `jsonObjectMode`. (DeepSeek rejects strict `responseSchema` — providers/types.ts:179-183.)
- **Derive the call budget; don't hard-code 2.** `GROUNDING_MAX_LLM_CALLS = 1 + GROUNDING_PARSE_MAX_RETRIES`. The call-cap test should assert against the constant, not a literal, so the relation stays auditable (fleet pattern, critic-deep.ts:16-18; test critic-deep.test.ts:111-116).
- **`unicode` section headers + `import type`.** ESLint `consistent-type-imports` is a hard gate — `LLMClient`, `Message`, `Passage` are all type-only. Section headers must be the box-drawing `// ── … ──────` form (principles.md:32), matching critic-deep.ts.
- **`feedback` is required, not optional.** `z.string()` (not `.optional()`). An approve with empty feedback is `{verdict:"approve", feedback:""}` — confirmed by fleet schema test (critic-deep.test.ts:122-124) and the missing-feedback rejection (critic-deep.test.ts:137-140).
- **`noUnusedLocals`/`noUnusedParameters` are on (strict).** Build the file so every import is used by the time you finish (add `Message`/`Passage` usage in the same commit, or the intermediate `tsc` in step 1 will error on unused imports — that's fine to defer to step 4/5, just don't ship with unused ones).
