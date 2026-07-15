# Sprint Briefing: Code-enforced non-emergency refusal layer

**Contract:** sprint-spec-20260617-medical-whoop-guardrails-1
**Generated:** 2026-06-17T00:00:00Z

> Self-contained sprint. Closes the documented refuse-branch placeholder in
> `src/medical/guardrails.ts:94-95`. Add a pure `RefusalDetector` (sibling of
> `RedFlagDetector`), wire `evaluate()` to emit `{kind:"refuse"}`, and add a
> refuse-dispatch branch in `MedicalSopEngine.run`. NO network, NO LLM, NO WHOOP.

---

## 1. Target Files

### src/medical/refusal.ts (create)

**Directory pattern:** `src/medical/*.ts` use kebab-case filenames, a top-of-file
JSDoc banner, unicode box-drawing section headers (`// ── Section ──`), `.js` import
extensions, and `import type` for type-only imports. The closest existing file to mirror
is **`src/medical/red-flag.ts`** (full file read; it is the canonical "pure detector" template).

**Most similar existing file:** `src/medical/red-flag.ts` — copy its exact structure:
1. JSDoc banner (state: pure, synchronous, NO async/fs/network/LLM, deterministic).
2. `// ── Type exports ──` → `export type RefusalCategory` + `export interface RefusalMatch`.
3. `// ── Version constant ──` → `export const REFUSAL_PATTERNSET_VERSION = "refusal-2026.06.17";`
4. `// ── Rule definitions ──` → `interface CategoryRule` + a small `const RULES: CategoryRule[]`.
5. `// ── RefusalDetector ──` → the class with `readonly patternsetVersion` and `detect()`.

**Structure template (model on red-flag.ts:14-31, :36, :40-45, :195-212):**
```ts
/**
 * RefusalDetector — pure, synchronous, 0-LLM non-emergency content-policy refusal.
 * Classifies prescription / specific-dosing / individualized-treatment-plan requests.
 * Conservative phrase matching: accept FALSE-NEGATIVES (fall through to 'none'),
 * NEVER false-positive into giving advice. Pattern set is versioned for audit.
 * NO async. NO fs. NO network. NO LLM import. Identical input => identical output.
 */

// ── Type exports ──
export type RefusalCategory =
  | "prescription"
  | "specific-dosing"
  | "individualized-treatment-plan"
  | "none";

export interface RefusalMatch {
  category: RefusalCategory;
  ruleId?: string; // IDs only, never prompt text; undefined when 'none'
}

// ── Version constant ──
export const REFUSAL_PATTERNSET_VERSION = "refusal-2026.06.17";

// ── Canned refuse reason strings (NEVER model-generated) ──
// Decline + see-a-licensed-clinician. Distinct from the 911/988 escalations.
const REFUSE_PRESCRIPTION = "I can't ... Please see a licensed clinician ...";
// ... one constant per category ...
export const REFUSAL_REASONS: Record<Exclude<RefusalCategory, "none">, string> = {
  prescription: REFUSE_PRESCRIPTION,
  "specific-dosing": REFUSE_DOSING,
  "individualized-treatment-plan": REFUSE_TREATMENT_PLAN,
};

// ── Rule definitions ──
interface CategoryRule {
  ruleId: string;
  category: Exclude<RefusalCategory, "none">;
  test: (norm: string) => boolean; // pure predicate over lowercased+trimmed prompt
}
const RULES: CategoryRule[] = [ /* conservative phrase matches */ ];

// ── RefusalDetector ──
export class RefusalDetector {
  readonly patternsetVersion = REFUSAL_PATTERNSET_VERSION;
  detect(prompt: string): RefusalMatch {
    const norm = prompt.toLowerCase().trim();
    for (const rule of RULES) {
      if (rule.test(norm)) return { category: rule.category, ruleId: rule.ruleId };
    }
    return { category: "none" };
  }
}
```
**Note:** Whether to export `REFUSAL_REASONS` from refusal.ts or define the reason
constants in guardrails.ts (mirroring `ESCALATION_911`/`ESCALATION_988` at
`guardrails.ts:30-39`) is a design choice. The contract says "Define fixed canned reason
strings per category as module constants (mirror ESCALATION_911/988 at guardrails.ts:30-39)".
Either location works as long as the test can assert byte-equality against the exported
constant (sc-1-4). Exporting from refusal.ts keeps the detector self-describing; exporting
from guardrails.ts is the more literal mirror. **Prefer exporting from refusal.ts** so the
engine and both test files can import the same constant without circular concerns.

**Conservative pattern hints (from generatorNotes, keep small + reviewable):**
- prescription: `prescribe`, `prescription for`, `write me a prescription`, `can you prescribe`
- specific-dosing: `what dose`, `how many mg`, `how much ... should i take`, `should i take ... mg`, `what dosage`
- individualized-treatment-plan: `treatment plan for me`, `what should i do to treat my`, `my treatment plan`, `personalized treatment`, `care plan for my`

---

### src/medical/guardrails.ts (modify)

**Relevant section — the placeholder to replace (lines 80-104):**
```ts
evaluate(prompt: string, _ctx: GuardrailContext): GuardrailVerdict {
  if (prompt.trim().length === 0) {
    throw new Error("GuardrailSet.evaluate: prompt must not be empty or whitespace-only");
  }

  const match = this.detector.detect(prompt);
  if (match.category !== "none") {
    return {
      kind: "short-circuit",
      rule: match.ruleId ?? match.category,
      cannedResponse: escalationFor(match.category),
    };
  }

  // bober: refuse branch for non-emergency refusals (treatment plans, prescriptions, etc.)
  //        is a placeholder this sprint; real content-policy rules land in S6.   <-- REPLACE HERE

  return { kind: "allow" };
}

/** Expose PATTERNSET_VERSION so callers don't need a separate import. */
get patternsetVersion(): string {
  return PATTERNSET_VERSION;
}
```

**Required changes:**
1. Add import: `import { RefusalDetector, REFUSAL_PATTERNSET_VERSION, REFUSAL_REASONS } from "./refusal.js";` (type-import the `RefusalCategory`/`RefusalMatch` if referenced).
2. Add a `readonly refusal = new RefusalDetector();` field alongside the existing `readonly detector = new RedFlagDetector();` (guardrails.ts:72).
3. In `evaluate()`, AFTER the red-flag short-circuit return (line 92) and BEFORE `return { kind: "allow" }` (line 97), insert:
```ts
const r = this.refusal.detect(prompt);
if (r.category !== "none") {
  return { kind: "refuse", rule: r.ruleId ?? r.category, reason: REFUSAL_REASONS[r.category] };
}
```
   This guarantees **red-flag precedence** (sc-1-5): the short-circuit `return` at line 87-92 fires first; refuse only reached when red-flag is `none`.
4. Expose the refusal patternset version for the engine's audit entry. Add a getter mirroring the existing `patternsetVersion` getter (guardrails.ts:101-103):
```ts
get refusalPatternsetVersion(): string {
  return REFUSAL_PATTERNSET_VERSION;
}
```
   (Do NOT overload the existing `patternsetVersion` getter — it must keep returning the red-flag `PATTERNSET_VERSION` for the existing short-circuit audit assertion at engine.test.ts:389.)
5. Update the file's JSDoc banner (guardrails.ts:8-11) — the "placeholder this sprint" note is now satisfied.

**Imports this file uses:** `GuardrailContext`, `GuardrailSet`, `GuardrailVerdict` (type) from `./types.js`; `RedFlagDetector`, `PATTERNSET_VERSION` from `./red-flag.js`; `RedFlagCategory` (type) from `./red-flag.js`.

**Imported by:** `src/medical/engine.ts:27` (`import { MedicalGuardrails } from "./guardrails.js"`), `src/medical/team.ts` (delegated guardrail builder), `src/medical/guardrails.test.ts:4`.

**Test file:** `src/medical/guardrails.test.ts` (exists — modify, add refuse cases).

---

### src/medical/engine.ts (modify)

**Relevant section — the consent-refuse path is the EXACT template for the new branch (lines 217-248):**
```ts
if (!hasConsent) {
  await auditLog.append({ tIso: now, event: "refuse", ruleId: "consent-required" });
  const refuseAnswer: MedicalAnswer = {
    body: CONSENT_REQUIRED_MSG, abstained: false, citations: [],
    disclaimerFooter: footer, shortCircuit: true,
  };
  const spec = createSpec("Medical SOP — consent refused", "...", []);
  return {
    success: false, spec, completedSprints: [], failedSprints: [], duration: 0,
    medicalAnswer: refuseAnswer,
  } as PipelineResult & { medicalAnswer: MedicalAnswer };
}
```

**The red-flag short-circuit branch is where you insert AFTER (lines 255-289):**
```ts
const verdict = guardrails.evaluate(userPrompt, {});
if (verdict.kind === "short-circuit") {
  await auditLog.append({
    tIso: now, event: "short-circuit", ruleId: verdict.rule,
    rulesetVersion: guardrails.rulesetVersion,
    patternsetVersion: "patternsetVersion" in guardrails
      ? (guardrails as { patternsetVersion: string }).patternsetVersion : undefined,
  });
  const scAnswer: MedicalAnswer = { body: verdict.cannedResponse, abstained: false,
    citations: [], disclaimerFooter: footer, shortCircuit: true };
  const scSpec = createSpec("Medical SOP — red-flag short-circuit", "...", []);
  return { success: true, spec: scSpec, completedSprints: [], failedSprints: [],
    duration: 0, medicalAnswer: scAnswer } as PipelineResult & { medicalAnswer: MedicalAnswer };
}
// verdict.kind === "allow" → proceed to the full SOP (S6).   <-- INSERT REFUSE BRANCH ABOVE THIS LINE (after line 289, before 291)
```

**Required new branch — insert at line ~290 (after the short-circuit `if` block, before the `// verdict.kind === "allow"` comment at line 291):**
```ts
if (verdict.kind === "refuse") {
  await auditLog.append({
    tIso: now,
    event: "refuse",
    ruleId: verdict.rule,
    rulesetVersion: guardrails.rulesetVersion,
    patternsetVersion:
      "refusalPatternsetVersion" in guardrails
        ? (guardrails as { refusalPatternsetVersion: string }).refusalPatternsetVersion
        : undefined,
  });

  const refuseAnswer: MedicalAnswer = {
    body: verdict.reason,
    abstained: false,
    citations: [],
    disclaimerFooter: footer,
    shortCircuit: true,
  };

  const refuseSpec = createSpec(
    "Medical SOP — content-policy refusal",
    "Refusal gate declined a prescription/dosing/treatment-plan request; no numerics/LLM reached.",
    [],
  );

  return {
    success: true,
    spec: refuseSpec,
    completedSprints: [],
    failedSprints: [],
    duration: 0,
    medicalAnswer: refuseAnswer,
  } as PipelineResult & { medicalAnswer: MedicalAnswer };
}
```

**TypeScript discriminated-union note:** After the `if (verdict.kind === "short-circuit")` block
returns, `verdict` narrows to `{kind:"allow"} | {kind:"refuse"}`. After the new
`if (verdict.kind === "refuse")` block returns, `verdict` narrows to `{kind:"allow"}` — so
the existing line-291 comment and downstream code still typecheck with no cast.
`verdict.reason` and `verdict.rule` are safely accessible inside the refuse block (union member at types.ts:14).

**`success` value choice:** Use `success: true` (a deliberate, valid refusal is a successful
turn — mirrors the red-flag short-circuit at engine.ts:282, NOT the consent failure at :240 which
is `false` because consent is a hard precondition). sc-1-6 does not assert `success`, but
`shortCircuit:true / abstained:false / citations:[]` are explicitly required.

**Imports this file uses (existing, no new imports needed for the engine refuse branch):**
`createSpec` from `../contracts/spec.js`, `AuditLog`, `MedicalGuardrails`, `MedicalAnswer` (type) from `./types.js`. The engine reads the refusal patternset via the duck-typed `"refusalPatternsetVersion" in guardrails` guard (mirroring the existing `"patternsetVersion" in guardrails` pattern at :262) — **no new import of refusal.ts in engine.ts is required**, keeping the engine decoupled from the detector.

**Imported by:** `src/orchestrator/workflow/selector.ts:126` (`new MedicalSopEngine()` — zero-arg constructor MUST stay intact), `src/medical/team.ts`, `src/medical/engine.test.ts:16`.

**Test file:** `src/medical/engine.test.ts` (exists — modify, add refuse dispatch + spy-never-called + audit assertions).

---

## 2. Patterns to Follow

### Pure detector class
**Source:** `src/medical/red-flag.ts`, lines 195-212
```ts
export class RedFlagDetector {
  readonly patternsetVersion = PATTERNSET_VERSION;
  detect(prompt: string): RedFlagMatch {
    const norm = prompt.toLowerCase().trim();
    for (const rule of RULES) {
      if (rule.test(norm)) return { category: rule.category, ruleId: rule.ruleId };
    }
    return { category: "none" };
  }
}
```
**Rule:** Lowercase+trim once, iterate an ordered `RULES` array, return the first hit, fall through to `'none'`. Synchronous, no constructor deps.

### Versioned patternset constant
**Source:** `src/medical/red-flag.ts:36`
```ts
export const PATTERNSET_VERSION = "redflag-2026.06.16";
```
**Rule:** Export a `<domain>-YYYY.MM.DD` version string constant; the detector exposes it via a `readonly` field. Use `"refusal-2026.06.17"`.

### Canned, never-model-generated reason strings
**Source:** `src/medical/guardrails.ts:30-39`
```ts
const ESCALATION_911 =
  "This may be a medical emergency. Call 911 (or your local emergency number) now.";
const ESCALATION_988 =
  "If you are in crisis, call or text 988 (US Suicide & Crisis Lifeline) now, " +
  "or 911 if you are in immediate danger.";
```
**Rule:** Reason text is a module constant returned verbatim — NEVER passed through an LLM. Refuse reasons must be a "decline + see-a-licensed-clinician" message, DISTINCT from 911/988 (do not include "911"/"988"/"emergency" so refuse text is byte-distinct from escalation text). Example shape: `"I can't provide a prescription or specific medication dosing. Please consult a licensed clinician who can evaluate you and prescribe appropriately."`

### Category → constant mapping switch
**Source:** `src/medical/guardrails.ts:42-55`
```ts
function escalationFor(category: RedFlagCategory): string {
  switch (category) {
    case "cardiac": case "stroke": case "anaphylaxis": return ESCALATION_911;
    case "self-harm": case "overdose": return ESCALATION_988;
    default: return ESCALATION_911;
  }
}
```
**Rule:** Map category → canned string via a `switch` or a typed `Record`. A `Record<Exclude<RefusalCategory,"none">, string>` is cleaner here since each refuse category has its own message.

### Engine refuse-dispatch (consent path = template)
**Source:** `src/medical/engine.ts:217-248` (consent) and `:255-289` (short-circuit)
**Rule:** Build a `MedicalAnswer` with the canned body + `disclaimer.footer()` + `shortCircuit:true` + `abstained:false` + `citations:[]`, append ONE audit entry (IDs/enums only) with `tIso: now`, return a `PipelineResult & { medicalAnswer }` via `createSpec(...)`. NEVER touch numerics/factstore/retriever/llm on this path.

### Audit entry — IDs/enums only
**Source:** `src/medical/engine.ts:256-265` and `src/medical/audit.ts:44-58`; allowed-keys set asserted at `engine.test.ts:211`
```ts
const allowed = new Set(["tIso", "event", "rulesetVersion", "patternsetVersion", "ruleId"]);
```
**Rule:** The refuse audit entry may contain ONLY `tIso`, `event:"refuse"`, `ruleId`, `rulesetVersion`, `patternsetVersion`. NEVER the prompt text or any health value.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `RedFlagDetector` | `src/medical/red-flag.ts:195` | `detect(prompt): RedFlagMatch` | Emergency detector — the structural template; runs FIRST in evaluate(), do not modify. |
| `PATTERNSET_VERSION` | `src/medical/red-flag.ts:36` | `const string` | Red-flag version string; keep guardrails `patternsetVersion` getter returning this. |
| `escalationFor` | `src/medical/guardrails.ts:42` | `(RedFlagCategory): string` | Existing category→canned-string mapper; mirror its shape for refuse. |
| `ESCALATION_911`/`ESCALATION_988` | `src/medical/guardrails.ts:30,37` | `const string` | Canned escalation text — the byte-fixed-string pattern to mirror. |
| `AuditLog.append` | `src/medical/audit.ts:44` | `(entry: AuditEntry): Promise<void>` | Append one IDs/enums-only audit line; use for the `event:"refuse"` entry. |
| `DisclaimerComposer.footer` | `src/medical/disclaimer.ts` | `(): string` | Versioned wellness footer; attach to the refuse MedicalAnswer (already computed as `footer` at engine.ts:212). |
| `createSpec` | `src/contracts/spec.ts` | `(title, desc, sprints): Spec` | Build the PipelineResult `spec`; used by both consent + short-circuit returns. |
| `MedicalGuardrails` | `src/medical/guardrails.ts:65` | `class implements GuardrailSet` | The class to extend with refusal wiring. |
| `GuardrailVerdict` (refuse member) | `src/medical/types.ts:14` | `{kind:"refuse"; rule; reason}` | Already-existing verdict — DO NOT add a new type, reuse it. |
| `AuditEntry` / `AuditEvent` | `src/medical/types.ts:64,77` | `event` includes `"refuse"` | Already supports refuse — reuse, do not extend. |

Utilities reviewed: `src/medical/*` (red-flag, guardrails, engine, audit, disclaimer, consent, numerics, types). No general `src/utils/` helper is needed — this is a self-contained, dependency-free string-matching sprint.

---

## 4. Prior Sprint Output

### Base medical team (spec-20260616-medical-team, 7 sprints — all on this branch)
**Created:** `src/medical/types.ts` — exports `GuardrailVerdict` (incl. `{kind:"refuse"}` at :14), `AuditEvent` (incl. `"refuse"` at :68), `AuditEntry` (:77), `GuardrailContext` (empty, :20), `MedicalAnswer` (:40), `GuardrailSet` (:25).
**Created:** `src/medical/red-flag.ts` — exports `RedFlagDetector`, `RedFlagMatch`, `RedFlagCategory`, `PATTERNSET_VERSION`. The pure-detector template.
**Created:** `src/medical/guardrails.ts` — exports `MedicalGuardrails`, `GUARDRAIL_RULESET_VERSION`. Has the documented refuse placeholder at :94-95.
**Created:** `src/medical/engine.ts` — `MedicalSopEngine` with the consent-refuse path (:217-248) and red-flag short-circuit (:255-289) dispatch templates; injectable deps (`MedicalSopDeps`, :47-66) including `llmClient`, `numerics`, `guardrails`.
**Created:** `src/medical/audit.ts` — `AuditLog.append` (IDs/enums-only jsonl writer).

**Connection to this sprint:** Every type/enum you need already exists — this sprint ONLY adds `RefusalDetector`, wires `evaluate()` to emit the existing `{kind:"refuse"}`, and adds the engine dispatch branch that mirrors the two existing dispatch templates. No types are added; `GuardrailContext` stays empty (ADR-3 / contract nonGoal).

---

## 5. Relevant Documentation

### Project Principles (.bober/principles.md)
- **ESM everywhere** — all imports use `.js` extensions for NodeNext (principles.md:27). `import { RefusalDetector } from "./refusal.js"`.
- **Use `type` imports** — `consistent-type-imports` is ESLint-enforced (principles.md:35). Type-only imports must be `import type {...}`.
- **Section comments** — unicode box-drawing headers `// ── Section ──` (principles.md:32).
- **No SDK lock-in** — never import `@anthropic-ai/sdk` or `openai` outside `providers/` adapters (principles.md:41). refusal.ts/guardrails.ts must import NEITHER.
- **No synchronous fs ops** — `node:fs/promises` only (principles.md:42). refusal.ts does ZERO fs.
- **Collocated tests** — `*.test.ts` next to `*.ts` (principles.md:20). Create `src/medical/refusal.test.ts`.
- **Prefix unused params with `_`** (principles.md:36) — note `evaluate(prompt, _ctx)` already uses this.

### Architecture Decisions
- **arch-20260617-medical-team-whoop-guardrails-adr-1.md:17** — "The refuse layer adds a `RefusalDetector` + a dispatch branch in `MedicalSopEngine.run` reusing existing types." Confirms the exact shape this sprint implements; WHOOP is a separate concern (Sprints 2-3).
- **ADR-3 (base medical team)** — `GuardrailContext` stays the empty placeholder. The contract nonGoals reiterate: do NOT add fields to GuardrailContext.
- **ADR-6 (base medical team) / eslint.config.js:71-95** — zero-egress: any `node:net`/`node:http`/`fetch`/network-pkg import under `src/medical/**` is a LINT ERROR (except the one sanctioned `retrieval/medline-source.ts`). refusal.ts and the guardrails change must add NONE.

### Other Docs
The contract `evaluatorNotes` and `generatorNotes` carry precise line references and the
exact pattern hints — they are the authoritative implementation guide and are reflected above.

---

## 6. Testing Patterns

### Unit Test Pattern — detector purity + categories
**Source:** `src/medical/red-flag.test.ts:8-34, :117-136` (this is the template for refusal.test.ts)
```ts
import { describe, it, expect } from "vitest";
import { RefusalDetector, REFUSAL_PATTERNSET_VERSION } from "./refusal.js";

describe("RefusalDetector — determinism", () => {
  it("detect is synchronous — does NOT return a Promise", () => {
    const result = new RefusalDetector().detect("can you prescribe me antibiotics?");
    expect(result).not.toBeInstanceOf(Promise);
  });
  it("exposes patternsetVersion constant", () => {
    expect(new RefusalDetector().patternsetVersion).toBe(REFUSAL_PATTERNSET_VERSION);
  });
});

describe("RefusalDetector — category hits", () => {
  it("detects prescription", () => {
    const m = new RefusalDetector().detect("can you prescribe me amoxicillin?");
    expect(m.category).toBe("prescription");
    expect(m.ruleId).toBeTruthy();
  });
  // ... specific-dosing ("how many mg of ibuprofen should I take?"),
  //     individualized-treatment-plan ("what's the treatment plan for me?")
});

describe("RefusalDetector — benign returns 'none'", () => {
  for (const prompt of ["what is blood pressure?", "what vitamins should I take?", "test"]) {
    it(`returns 'none' for: "${prompt}"`, () => {
      const m = new RefusalDetector().detect(prompt);
      expect(m.category).toBe("none");
      expect(m.ruleId).toBeUndefined();
    });
  }
});
```

### Unit Test Pattern — no-network source-scan (sc-1-8)
**Source:** `src/medical/red-flag.test.ts:140-159` and `guardrails.test.ts:99-118` — copy verbatim for refusal.ts
```ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

it("refusal.ts does NOT import from src/providers", async () => {
  const src = await readFile(fileURLToPath(new URL("./refusal.ts", import.meta.url)), "utf-8");
  expect(src).not.toMatch(/from\s+["'].*providers/);
});
it("refusal.ts does NOT import node:http/net/https or fetch", async () => {
  const src = await readFile(fileURLToPath(new URL("./refusal.ts", import.meta.url)), "utf-8");
  expect(src).not.toContain("node:http");
  expect(src).not.toContain("node:net");
  expect(src).not.toContain("node:https");
  expect(src).not.toContain("fetch(");
});
```

### Unit Test Pattern — guardrails refuse + fixed text + red-flag precedence
**Source:** `src/medical/guardrails.test.ts:24-95` (add new describe blocks)
```ts
import { MedicalGuardrails } from "./guardrails.js";
import { REFUSAL_REASONS } from "./refusal.js";

it("returns refuse with byte-equal fixed reason for prescription (sc-1-4)", () => {
  const v = new MedicalGuardrails().evaluate("can you prescribe me antibiotics?", {});
  expect(v.kind).toBe("refuse");
  if (v.kind === "refuse") {
    expect(v.reason).toBe(REFUSAL_REASONS.prescription); // byte-equal => not model-generated
    expect(v.rule).toBeTruthy();
  }
});

it("red-flag wins over refuse (emergency precedence, sc-1-5)", () => {
  // prompt matches BOTH a red-flag (overdose) AND a refuse (dosing) pattern
  const v = new MedicalGuardrails().evaluate(
    "I think I overdose — how many mg should I take next?", {});
  expect(v.kind).toBe("short-circuit"); // NOT refuse
});

it("still allows a benign prompt", () => {
  expect(new MedicalGuardrails().evaluate("what is blood pressure?", {}).kind).toBe("allow");
});
```
NOTE: choose a sc-1-5 prompt whose refuse trigger and red-flag trigger are both real, e.g.
combine a red-flag phrase ("overdose"/"kill myself"/"chest pain ... left arm") with a refuse
phrase ("how many mg should I take"). Verify your chosen prompt actually fires the refuse rule
in isolation first, otherwise the precedence test is hollow.

### Unit Test Pattern — engine dispatch + spy-LLM-never-called + audit
**Source:** `src/medical/engine.test.ts:297-395` (red-flag spy test is the EXACT template). Reuse the `recordTestConsent(dir)` helper at engine.test.ts:298-312.
```ts
it("refuse prompt → canned answer, 0 LLM/numerics, single 'refuse' audit entry (sc-1-6/sc-1-7)", async () => {
  const config = createDefaultConfig("test", "greenfield");
  vi.clearAllMocks();
  const { auditLog, gate, disclaimer } = await recordTestConsent(tmpDir2); // consent must pass

  const llmSpy: LLMClient = { chat: vi.fn() };   // throws-if-asserted-called pattern
  const numericsSpy = vi.fn();
  const engine = new MedicalSopEngine({
    auditLog, consentGate: gate, disclaimer, llmClient: llmSpy, numerics: numericsSpy,
  });

  const result = await engine.run("can you prescribe me antibiotics?", tmpDir2, config,
    { now: "2026-06-16T10:00:00.000Z" });

  const answer = (result as PipelineResult & { medicalAnswer: MedicalAnswer }).medicalAnswer;
  expect(answer.body).toBe(REFUSAL_REASONS.prescription); // canned, byte-equal
  expect(answer.shortCircuit).toBe(true);
  expect(answer.abstained).toBe(false);
  expect(answer.citations).toEqual([]);
  expect(answer.disclaimerFooter).toBeTruthy();

  expect(llmSpy.chat).not.toHaveBeenCalled();   // 0 LLM
  expect(numericsSpy).not.toHaveBeenCalled();   // 0 numerics

  const bytes = await readFile(join(tmpDir2, ".bober","medical","audit-2026-06-16.jsonl"), "utf-8");
  const entries = bytes.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string,unknown>);
  const refuseEntries = entries.filter((e) => e["event"] === "refuse");
  expect(refuseEntries.length).toBe(1);   // exactly one refuse entry
  expect(refuseEntries[0]?.["ruleId"]).toBeTruthy();
  expect(refuseEntries[0]?.["rulesetVersion"]).toBeTruthy();
  expect(refuseEntries[0]?.["patternsetVersion"]).toBeTruthy();
  expect(bytes).not.toContain("prescribe");   // no prompt text in audit
});
```
**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** `vi.fn()` / `vi.spyOn` injected via `MedicalSopDeps` constructor arg. **File naming:** `<name>.test.ts`. **Location:** collocated in `src/medical/`. **Temp dirs:** `mkdtemp(join(tmpdir(), "bober-medical-eng-"))` in `beforeEach`, `rm(..., {recursive,force})` in `afterEach` (engine.test.ts:79-85).

### E2E Test Pattern
Not applicable — this is a pure-logic/library sprint with no UI and no Playwright config in scope.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/medical/engine.ts` | `guardrails.ts` (`evaluate` now returns `refuse`) | low | New verdict kind is handled by the new branch; existing allow/short-circuit paths unchanged. |
| `src/medical/team.ts` | `guardrails.ts` (`MedicalGuardrails`) | low | Only the class is imported; constructor stays zero-arg, public surface only grows. |
| `src/orchestrator/workflow/selector.ts:126` | `engine.ts` (`new MedicalSopEngine()`) | low | Zero-arg constructor + `run()` signature MUST stay intact (contract nonGoal). Do not change them. |
| `src/medical/guardrails.test.ts` | `guardrails.ts` | low | Existing short-circuit/allow assertions must still pass; you ADD refuse cases. |
| `src/medical/engine.test.ts` | `engine.ts` | low | Existing consent/short-circuit/allow/numeric tests must still pass; you ADD refuse cases. |

### Existing Tests That Must Still Pass
- `src/medical/guardrails.test.ts` — asserts short-circuit (5 categories), `allow` on benign, empty-prompt throw, `patternsetVersion === PATTERNSET_VERSION` (red-flag, :91-94). **Verify the red-flag `patternsetVersion` getter is unchanged** — do not let the new refusal version shadow it.
- `src/medical/engine.test.ts:342-395` — red-flag short-circuit with `patternsetVersion === PATTERNSET_VERSION` audit assertion (:389) and `llmSpy`/`numericsSpy` never called. **Your refuse branch must not run before the short-circuit branch.**
- `src/medical/engine.test.ts:182-217` — PHI-free audit: allowed-key set is `{tIso,event,rulesetVersion,patternsetVersion,ruleId}` (:211). The refuse audit entry must use ONLY these keys.
- `src/medical/engine.test.ts:399-430` — benign allow path must still reach `success:true, shortCircuit:false`. **Ensure your refuse rules do NOT false-positive on `"what was my average resting heart rate last week"` or `"what vitamins should I take?"`** (these benign prompts are used across the suite).
- `src/medical/red-flag.test.ts` — unchanged; do not touch red-flag.ts.

### Features That Could Be Affected
- **Red-flag emergency short-circuit** — shares `evaluate()`. Verify red-flag precedence (sc-1-5) by placing the refuse check strictly AFTER the short-circuit return.
- **Consent gate refuse path** — shares the `event:"refuse"` audit event AND `ruleId:"consent-required"`. Your engine refuse branch uses a DIFFERENT `ruleId` (the refusal rule/category) — confirm tests distinguish them (consent refuse has `success:false` + `ruleId:"consent-required"`; content refuse has the refusal ruleId).
- **Benign allow → full SOP** (numerics/factstore/literature) — must remain reachable; refuse only triggers on the 3 refuse categories.

### Recommended Regression Checks
After implementation, the Generator MUST run:
1. `npm run typecheck` — zero errors (strict mode; verify the `verdict` union narrows cleanly with no cast in the refuse branch).
2. `npm run build` — zero TS errors.
3. `npx vitest run src/medical/` — all medical tests pass (new + existing; especially the red-flag short-circuit, benign-allow, and PHI-free-audit tests above).
4. `npm run test` — FULL suite, zero regressions (base was ~2393 tests per project memory).
5. `npm run lint` — zero errors; specifically the scoped medical egress boundary (eslint.config.js:71-95). Confirm refusal.ts/guardrails.ts have NO `@anthropic-ai/sdk`, `openai`, `node:net`, `node:http`, `fetch` imports.

---

## 8. Implementation Sequence

1. **src/medical/refusal.ts (create)** — types (`RefusalCategory`, `RefusalMatch`), `REFUSAL_PATTERNSET_VERSION`, canned reason constants + `REFUSAL_REASONS` record, `RULES`, `RefusalDetector`. Pure/sync, no imports.
   - Verify: `npm run typecheck` clean; the file imports nothing from `./` except (optionally) types. No fs/net/llm imports.
2. **src/medical/refusal.test.ts (create)** — each category hit, benign `none` cases, sync purity, version exposure, the no-network source-scan tests.
   - Verify: `npx vitest run src/medical/refusal.test.ts` green.
3. **src/medical/guardrails.ts (modify)** — import refusal symbols; add `readonly refusal = new RefusalDetector()`; insert the refuse check in `evaluate()` after the short-circuit return; add `refusalPatternsetVersion` getter; update the JSDoc banner. Keep the existing `patternsetVersion` getter returning red-flag `PATTERNSET_VERSION`.
   - Verify: `npx vitest run src/medical/guardrails.test.ts` (existing green); typecheck clean.
4. **src/medical/guardrails.test.ts (modify)** — add refuse-verdict + byte-equal fixed-text + red-flag-precedence + benign-allow tests.
   - Verify: those new tests pass; existing short-circuit/allow/throw tests still pass.
5. **src/medical/engine.ts (modify)** — insert the `if (verdict.kind === "refuse")` dispatch branch after the short-circuit block (after line 289). Reuse `auditLog`, `footer`, `createSpec`, `guardrails.rulesetVersion`, and the duck-typed `refusalPatternsetVersion`.
   - Verify: typecheck clean (union narrows, no cast); no new imports of numerics/factstore/llm on this path.
6. **src/medical/engine.test.ts (modify)** — add the refuse dispatch + spy-never-called + single-`refuse`-audit-entry + no-prompt-text test (template at :297-395; reuse `recordTestConsent`).
   - Verify: new test passes; existing engine tests (short-circuit, consent, benign, PHI-free) still pass.
7. **Run full verification** — `npm run typecheck`, `npm run build`, `npm run test`, `npm run lint`. All green, no regression.

---

## 9. Pitfalls & Warnings

- **Red-flag precedence is order-dependent.** The refuse check MUST sit AFTER the short-circuit `return` in `evaluate()` (guardrails.ts:87-92). If you put it first, sc-1-5 fails and emergencies get a refuse instead of a 911/988 escalation — a safety regression.
- **Do NOT shadow the existing `patternsetVersion` getter.** guardrails.ts:101-103 returns the RED-FLAG version and engine.test.ts:389 asserts `=== PATTERNSET_VERSION`. Add a SEPARATE `refusalPatternsetVersion` getter; the engine reads it via `"refusalPatternsetVersion" in guardrails` (do not reuse the red-flag key for the refuse audit).
- **Audit entry: IDs/enums ONLY.** engine.test.ts:211 enforces the allowed-key set `{tIso,event,rulesetVersion,patternsetVersion,ruleId}`. Never put the prompt or any health value into the audit entry. `event` must be the literal `"refuse"`.
- **Byte-equal reason is the proof of non-model-generation (sc-1-4/sc-1-6).** Export the reason constant and assert `===` against it in tests. Do NOT compose the reason dynamically.
- **Refuse text must be distinct from 911/988.** Do not include "911", "988", or "emergency" in refuse reasons, or precedence/PHI tests that grep for hotlines could collide. Use a "decline + see a licensed clinician" message.
- **Conservative matching — accept false-negatives, never false-positives.** Benign prompts used across the existing suite (`"what vitamins should I take?"`, `"what was my average resting heart rate last week"`, `"what is blood pressure?"`, `"test"`) MUST still return `allow`. Test these explicitly to guard against an over-broad rule (e.g. a bare `"take"` or `"mg"` substring would false-positive).
- **No new egress imports (sc-1-8 / eslint.config.js:71-95).** refusal.ts and the guardrails diff must import zero network/SDK modules. The scoped ESLint medical boundary will error on `node:net`/`node:http`/`fetch`/`@anthropic-ai/sdk`/`openai`/`undici`/`axios`/etc.
- **Zero-arg constructor + `run()` signature are LOCKED** (contract nonGoal; selector.ts:126). Add the refuse branch INSIDE `run`; do not change the method signature or `MedicalSopEngine` constructor.
- **GuardrailContext stays empty** (ADR-3, contract nonGoal). Do not add fields to it.
- **`success` semantics:** use `success: true` for content refusal (valid declined turn, mirrors short-circuit at engine.ts:282), NOT `false` (that is reserved for the consent precondition failure at engine.ts:240).
- **Do not re-read or edit red-flag.ts** — it is the template, not a target. Changing it risks the existing red-flag suite (contract nonGoal).
