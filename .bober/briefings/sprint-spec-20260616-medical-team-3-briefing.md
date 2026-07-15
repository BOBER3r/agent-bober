# Sprint Briefing: Red-flag emergency short-circuit (Gate 2, 0 LLM calls)

**Contract:** sprint-spec-20260616-medical-team-3
**Generated:** 2026-06-16T00:00:00Z

---

## 0. TL;DR — what to build

Add a **pure/synchronous** `RedFlagDetector` (`src/medical/red-flag.ts`) and a **real** `GuardrailSet`
(`src/medical/guardrails.ts`) replacing the S1 allow-only stub in `team.ts`. Wire `GuardrailSet.evaluate`
into `MedicalSopEngine.run` as **Gate 2**, immediately AFTER the consent gate (`engine.ts:107`) and BEFORE
any numerics/LLM/retrieval. A red-flag match returns a canned 911/988 escalation `MedicalAnswer`
(`shortCircuit: true`) + a `short-circuit` audit entry and reaches NO downstream work.

**Carry-forward (CRITICAL):** Extend `MedicalSopDeps` with an `llmClient?: LLMClient` slot and a
`numerics?` slot, and ACTUALLY inject spies in `engine.test.ts` so the "zero downstream calls" assertion is
real (S2's was structurally hollow). See Section 6 below.

---

## 1. Target Files

### `src/medical/red-flag.ts` (create)

**Directory pattern:** `src/medical/` modules are kebab-cased `.ts` with collocated `.test.ts`
(`audit.ts`/`audit.test.ts`, `consent.ts`/`consent.test.ts`, `disclaimer.ts`/`disclaimer.test.ts`).
**Most similar existing file:** `src/medical/disclaimer.ts` (pure, no I/O, versioned constant) for module
shape + `src/chat/turn-classifier.ts` for the normalize/pattern style (but WITHOUT the LLM — detection is local).

**Structure template (mirror disclaimer.ts:1-26 + ADR-2):**
```typescript
/** RedFlagDetector — pure, synchronous, 0-LLM emergency detection (Phase 6, Sprint 3). */

export type RedFlagCategory =
  | "cardiac" | "stroke" | "anaphylaxis" | "self-harm" | "overdose" | "none";

export interface RedFlagMatch {
  category: RedFlagCategory;
  /** Rule ID that fired (IDs only — never text). Undefined when category === 'none'. */
  ruleId?: string;
}

/** Versioned pattern-set identifier recorded in the audit log (ADR-2). */
export const PATTERNSET_VERSION = "redflag-2026.06.16";

// One conservative pattern list per category. Word-boundary regex or phrase includes.
// Order matters: self-harm/overdose checked so the right hotline (988) wins.
interface CategoryRule { ruleId: string; category: RedFlagCategory; test: (norm: string) => boolean; }

const RULES: CategoryRule[] = [ /* cardiac, stroke, anaphylaxis, self-harm, overdose */ ];

/**
 * PURE + SYNCHRONOUS. No async, no fs, no network, no LLM import.
 * Identical input ⇒ identical RedFlagMatch (asserted by sc-3-5).
 */
export class RedFlagDetector {
  readonly patternsetVersion = PATTERNSET_VERSION;
  detect(prompt: string): RedFlagMatch {
    const norm = prompt.toLowerCase().trim();
    for (const rule of RULES) if (rule.test(norm)) return { category: rule.category, ruleId: rule.ruleId };
    return { category: "none" };
  }
}
```
**Imports this file needs:** NONE. It MUST NOT import from `src/providers/*` or any network module
(sc-3-5 / sc-3-8 assert this). Keep it dependency-free.

**Category patterns (from `generatorNotes` + assumptions):**
- **cardiac** → 911: `chest pain` (+ `radiating` / `short of breath`)
- **stroke** → 911: FAST — `face droop`, `arm weakness`, `slurred speech`, `sudden numbness`
- **anaphylaxis** → 911: `throat closing`, `trouble breathing` (+ `allergic`/`sting`/`peanut`)
- **self-harm** → 988: `kill myself`, `suicidal`, `end my life`
- **overdose** → 988: `overdose`, `took too many`, `too much`

**Test file:** `src/medical/red-flag.test.ts` (create).

---

### `src/medical/guardrails.ts` (create)

**Most similar existing file:** the stub `buildMedicalGuardrails` in `src/medical/team.ts:40-47` — this is the
exact shape to REPLACE (move into `guardrails.ts`, make it real). It must keep returning `{ kind: "allow" }`
for benign prompts because `team.test.ts:44-50` asserts `evaluate("what is blood pressure?", {})` ⇒ `allow`.

**Structure template:**
```typescript
/** Real medical GuardrailSet — wraps RedFlagDetector (Phase 6, Sprint 3). */
import type { GuardrailContext, GuardrailSet, GuardrailVerdict } from "./types.js";
import { RedFlagDetector, PATTERNSET_VERSION } from "./red-flag.js";
import type { RedFlagCategory } from "./red-flag.js";

export const GUARDRAIL_RULESET_VERSION = "guardrail-2026.06.16";

const ESCALATION_911 =
  "This may be a medical emergency. Call 911 (or your local emergency number) now.";
const ESCALATION_988 =
  "If you are in crisis, call or text 988 (US Suicide & Crisis Lifeline) now, " +
  "or 911 if you are in immediate danger.";

/** Fixed strings — NEVER model-generated. */
function escalationFor(category: RedFlagCategory): string {
  switch (category) {
    case "cardiac": case "stroke": case "anaphylaxis": return ESCALATION_911;
    case "self-harm": case "overdose": return ESCALATION_988;
    default: return ESCALATION_911; // unreachable for 'none'
  }
}

export class MedicalGuardrails implements GuardrailSet {
  readonly rulesetVersion = GUARDRAIL_RULESET_VERSION;
  // Expose for the engine's audit entry. The detector owns patternsetVersion.
  readonly detector = new RedFlagDetector();

  evaluate(prompt: string, _ctx: GuardrailContext): GuardrailVerdict {
    if (prompt.trim().length === 0) throw new Error("GuardrailSet.evaluate: empty prompt"); // sc-3-8
    const match = this.detector.detect(prompt);
    if (match.category !== "none") {
      return { kind: "short-circuit", rule: match.ruleId ?? match.category, cannedResponse: escalationFor(match.category) };
    }
    return { kind: "allow" };
  }
}
```
**Note:** The `refuse` branch (non-emergency code-enforced refusals) is a documented placeholder this sprint
(per `generatorNotes` "refuse branch ... can be a documented placeholder this sprint or minimal"). Add a
`// bober:` comment that real refusals land in S6.
**Imports this file needs:** `./types.js` (GuardrailSet/GuardrailVerdict/GuardrailContext), `./red-flag.js`.
It MUST NOT import any provider/network module (sc-3-8: "a test confirms no provider is constructed").
**Test file:** `src/medical/guardrails.test.ts` (create).

---

### `src/medical/engine.ts` (modify)

**Relevant section — MedicalSopDeps (lines 27-31, EXTEND):**
```typescript
export interface MedicalSopDeps {
  auditLog?: AuditLog;
  consentGate?: ConsentGate;
  disclaimer?: DisclaimerComposer;
  // ── ADD in S3 ──
  guardrails?: GuardrailSet;            // inject the real MedicalGuardrails (or a fake)
  llmClient?: LLMClient;                // CARRY-FORWARD #1: spy seam, asserted never called
  numerics?: () => unknown;             // fake numerics seam, asserted never called on short-circuit
}
```

**Relevant section — the allow-only stub to REPLACE (lines 109-126):** currently after consent it just
appends an `answer` entry and returns a placeholder. INSERT Gate 2 between consent (ends line 107) and the
current placeholder path. New flow:
```typescript
// ── Construct guardrails when not injected (S3) ──
const guardrails = this.deps?.guardrails ?? buildMedicalGuardrails(); // or new MedicalGuardrails()

// ── Gate 2: Red-flag short-circuit (0 LLM, 0 numerics) ──
const verdict = guardrails.evaluate(userPrompt, {});
if (verdict.kind === "short-circuit") {
  await auditLog.append({
    tIso: now,
    event: "short-circuit",
    ruleId: verdict.rule,
    rulesetVersion: guardrails.rulesetVersion,
    patternsetVersion: PATTERNSET_VERSION, // or guardrails.detector.patternsetVersion
  });
  const scAnswer: MedicalAnswer = {
    body: verdict.cannedResponse,
    abstained: false,
    citations: [],
    disclaimerFooter: footer,
    shortCircuit: true,
  };
  const spec = createSpec("Medical SOP — red-flag short-circuit",
    "Red-flag gate escalated; no numerics/LLM reached.", []);
  return { success: true, spec, completedSprints: [], failedSprints: [], duration: 0,
    medicalAnswer: scAnswer } as PipelineResult & { medicalAnswer: MedicalAnswer };
}
// verdict.kind === "allow" → fall through to the existing placeholder path (lines 111-141).
```
**New imports engine.ts needs:** add to the existing import block —
`import type { GuardrailSet } from "./types.js";`,
`import type { LLMClient } from "../providers/types.js";`,
`import { PATTERNSET_VERSION } from "./red-flag.js";` (or read it off the injected guardrails),
and either `import { buildMedicalGuardrails } from "./team.js"` OR `import { MedicalGuardrails } from "./guardrails.js"`.
**Caution (circular import):** `team.ts` imports nothing from `engine.ts`, but `team.ts` will now import from
`guardrails.ts`. Have `engine.ts` default to `new MedicalGuardrails()` directly (NOT via team.ts) to avoid
pulling `resolveRoleProviders` and the team graph into the engine. Cleaner dependency edge.

**Imported by:** `src/orchestrator/workflow/selector.ts` calls `new MedicalSopEngine()` (zero-arg ctor —
PRESERVE it). `src/medical/team.ts` does NOT import engine.ts.
**Test file:** `src/medical/engine.test.ts` (exists — extend it).

---

## 2. Patterns to Follow

### Pattern A — Pure versioned module (no I/O)
**Source:** `src/medical/disclaimer.ts`, lines 5-26
```typescript
const DISCLAIMER_VERSION = "1.0.0";
const FOOTER_TEXT = "General wellness information only — not medical advice...";
export class DisclaimerComposer {
  readonly disclaimerVersion = DISCLAIMER_VERSION;
  footer(): string { return `${FOOTER_TEXT} [disclaimer v${this.disclaimerVersion}]`; }
}
```
**Rule:** Version is a module-level `const`, exposed as a `readonly` instance field; fixed strings are
module-level consts. `RedFlagDetector` and `MedicalGuardrails` follow this exactly (`PATTERNSET_VERSION`,
`GUARDRAIL_RULESET_VERSION`, fixed escalation strings).

### Pattern B — Discriminated-union verdict + switch
**Source:** `src/medical/types.ts`, lines 11-14
```typescript
export type GuardrailVerdict =
  | { kind: "allow" }
  | { kind: "short-circuit"; rule: string; cannedResponse: string }
  | { kind: "refuse"; rule: string; reason: string };
```
**Rule:** Return the union directly; narrow with `verdict.kind === "short-circuit"`. Do not invent new fields.

### Pattern C — Optional-deps injection seam (zero-arg ctor preserved)
**Source:** `src/medical/engine.ts`, lines 53, 66-68
```typescript
constructor(private readonly deps?: MedicalSopDeps) {}
// ...
const auditLog = this.deps?.auditLog ?? new AuditLog(projectRoot);
const consentGate = this.deps?.consentGate ?? new ConsentGate(projectRoot, auditLog);
const disclaimer = this.deps?.disclaimer ?? new DisclaimerComposer();
```
**Rule:** Each dep is `this.deps?.X ?? new RealX()`. Add `guardrails`, `llmClient`, `numerics` the same way.
NEVER add a required constructor argument — `selector.ts` calls `new MedicalSopEngine()`.

### Pattern D — Injected timestamp, never wall-clock in tests
**Source:** `src/medical/engine.ts`, lines 62-63; audit/consent take `tIso`/`nowIso` params
```typescript
const now = opts?.now ?? new Date().toISOString();
```
**Rule:** The short-circuit audit entry uses `tIso: now`. Tests MUST inject `opts.now` (carry-forward #2).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `AuditLog.append` | `src/medical/audit.ts:44` | `(entry: AuditEntry): Promise<void>` | Append-only JSONL (O_APPEND, mode 0600), IDs/enums only. Use for the `short-circuit` entry. |
| `ConsentGate.hasConsent` | `src/medical/consent.ts:39` | `(): Promise<boolean>` | Gate 1 (already wired). Do not touch. |
| `ConsentGate.current` | `src/medical/consent.ts:47` | `(): Promise<ConsentRecord \| undefined>` | Reads consent record. |
| `DisclaimerComposer.footer` | `src/medical/disclaimer.ts:23` | `(): string` | Versioned footer for the short-circuit `MedicalAnswer`. |
| `buildMedicalGuardrails` | `src/medical/team.ts:40` | `(): GuardrailSet` | **The allow-only stub to REPLACE** — move real logic to `guardrails.ts`, have team.ts call it. |
| `createSpec` | `src/contracts/spec.ts` | `(title, description, sprints)` | Builds the `spec` field of `PipelineResult` (used at engine.ts:91,128). |
| `GuardrailVerdict` / `GuardrailSet` / `GuardrailContext` | `src/medical/types.ts:11,25,20` | types | Reuse — do NOT redefine. `GuardrailContext` is `{}` (empty placeholder); pass `{}` from the engine. |
| `AuditEntry` (with `patternsetVersion`/`ruleId`/`rulesetVersion`) | `src/medical/types.ts:76-86` | type | Already has the optional fields the short-circuit needs. Do NOT widen. `event: "short-circuit"` already in `AuditEvent` (types.ts:64-70). |
| `LLMClient` | `src/providers/types.ts:216-222` | `{ chat(params: ChatParams): Promise<ChatResponse> }` | The exact type for the injectable spy seam (Section 6). |

**Utilities reviewed:** `src/medical/*`, `src/providers/types.ts`, `src/chat/turn-classifier.ts`. No generic
`utils/`/`lib/` helper applies to detection — keep `red-flag.ts` dependency-free per ADR-2.

---

## 4. Prior Sprint Output

### Sprint 1 (60215d2): pipeline plumbing
**Created:** `src/medical/types.ts` (GuardrailSet/Verdict/Context, MedicalAnswer, AuditEntry, AuditEvent),
`src/medical/team.ts` (`buildMedicalGuardrails` allow-only stub, `MEDICAL_RULESET_VERSION = "0.0.0"`),
`src/medical/engine.ts` (`MedicalSopEngine`, zero-arg ctor).
**Connection:** S3 replaces the `buildMedicalGuardrails` stub body; the `GuardrailVerdict` union and
`event: "short-circuit"` enum already exist — reuse, don't redefine.

### Sprint 2 (4e0286d): consent / audit / disclaimer
**Created:** `src/medical/consent.ts` (ConsentGate, Gate 1), `src/medical/audit.ts` (AuditLog),
`src/medical/disclaimer.ts` (DisclaimerComposer); wired consent as Gate 1 in `engine.ts:72-107` and added the
`MedicalSopDeps` seam (`engine.ts:27-31`). `AuditEntry.patternsetVersion` reserved (types.ts:83).
**Connection:** S3 inserts Gate 2 right after consent (after `engine.ts:107`), reuses `AuditLog.append` and the
`DisclaimerComposer.footer()` already computed at `engine.ts:70`, and EXTENDS `MedicalSopDeps`.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` found at project root. Tech-stack rules from the contract apply: TypeScript strict,
ESM/NodeNext with `.js` import extensions, Vitest, no SDK types outside `src/providers/`, no sync fs.

### Architecture Decisions
- **ADR-2** (`.bober/architecture/arch-20260616-medical-team-adr-2.md`): "Red-Flag Gate as a Pre-LLM
  Deterministic Component." Decision: `RedFlagDetector.detect()` is **pure/synchronous, 0-LLM, runs first**;
  short-circuit returns a **canned escalation with zero downstream calls**; carries a `patternsetVersion`
  recorded in the audit log. **Accepted risk:** novel phrasing may return `none` and proceed to normal
  (still-guardrailed) handling — favor a conservative, versioned pattern set. Document this risk in a comment.
- **ADR-3** (`...-adr-3.md`): numerics are in-process whitelisted primitives — but numerics is S4 (out of scope
  here; the numerics dep may be a fake/stub).
- **Architecture doc** (`...-architecture.md`): Data-flow line 270 `GuardrailSet.evaluate → RedFlagDetector.detect
  ..... GATE 2 (0 LLM)`; line 278 "(1b) SHORT-CIRCUIT: ... Numerics / Retriever / LLM NEVER reached (0 LLM, 0
  egress)"; API-contract line 247 `GuardrailSet.evaluate → throws on empty prompt`; interface sketches at lines
  62-65 (`GuardrailSet`) and 72-75 (`RedFlagDetector`, with the exact category list).

### Other Docs
No `CLAUDE.md`/`CONTRIBUTING.md` coding-guideline file in repo root governing src; conventions are inferred
from sibling modules (Section 2).

---

## 6. CRITICAL — MedicalSopDeps `llmClient` Injection Seam (carry-forward finding #1)

**Problem from S2 eval:** the S2 `sc-2-4` test created `const llmSpy = { chat: vi.fn() }` and
`const numericsSpy = vi.fn()` (`engine.test.ts:121-122`) but NEVER injected them — `MedicalSopDeps` had no LLM
slot, so `expect(llmSpy.chat).not.toHaveBeenCalled()` (line 148) was structurally hollow (it could never have
been called because the engine had no reference to it).

**S3 fix — exact type + exact injection point:**

1. **The type** (`src/providers/types.ts:216-222`):
   ```typescript
   export interface LLMClient { chat(params: ChatParams): Promise<ChatResponse>; }
   ```
   A test fake: `const llmSpy: LLMClient = { chat: vi.fn() };` (matches `ScriptedClient` in
   `src/chat/turn-classifier.test.ts:9-20`).

2. **Where the slot goes** — extend `MedicalSopDeps` (`src/medical/engine.ts:27-31`):
   ```typescript
   export interface MedicalSopDeps {
     auditLog?: AuditLog;
     consentGate?: ConsentGate;
     disclaimer?: DisclaimerComposer;
     guardrails?: GuardrailSet;
     llmClient?: LLMClient;        // ← injected; spied; asserted never called on short-circuit
     numerics?: () => unknown;     // ← fake numerics seam; spied; asserted never called on short-circuit
   }
   ```

3. **Where it would be consumed** — the short-circuit branch returns BEFORE any use of `this.deps?.llmClient`
   or `this.deps?.numerics`, so neither is invoked. The engine should hold the reference
   (`const llmClient = this.deps?.llmClient; const numerics = this.deps?.numerics;`) near the other dep
   resolution (after `engine.ts:68`) so the seam is real, then NOT touch it on the short-circuit path. (On the
   allow path this sprint, the placeholder may call `numerics?.()` once if you want the "none proceeds" test to
   prove the allow path is reachable — but DO NOT call the LLM; that's S6.)

4. **In the test** (extend `engine.test.ts`): construct
   `const engine = new MedicalSopEngine({ auditLog, consentGate, disclaimer, llmClient: llmSpy, numerics: numericsSpy });`
   record consent first (Gate 1 must pass so Gate 2 is reached), run an emergency prompt, then assert
   `expect(llmSpy.chat).not.toHaveBeenCalled()` AND `expect(numericsSpy).not.toHaveBeenCalled()` — now the
   assertion is REAL because the engine actually holds the references.

---

## 7. Testing Patterns

### Unit Test Pattern — pure detector determinism (sc-3-5)
**Source:** mirror the structure of `src/chat/turn-classifier.test.ts` (collocated, `describe/it/expect`).
```typescript
import { describe, it, expect } from "vitest";
import { RedFlagDetector, PATTERNSET_VERSION } from "./red-flag.js";

describe("RedFlagDetector — determinism (sc-3-5)", () => {
  it("identical input yields identical RedFlagMatch", () => {
    const d = new RedFlagDetector();
    const a = d.detect("I have crushing chest pain radiating to my arm");
    const b = d.detect("I have crushing chest pain radiating to my arm");
    expect(a).toEqual(b);                 // deep-equal
    expect(a.category).toBe("cardiac");
  });
  it("detect is synchronous (not a Promise)", () => {
    const r = new RedFlagDetector().detect("hello");
    expect(r).not.toBeInstanceOf(Promise);
    expect(r.category).toBe("none");
  });
});
```

### Unit Test Pattern — no-provider/no-network import (sc-3-8)
Assert `guardrails.ts`/`red-flag.ts` import nothing from `src/providers`. Use a source-read assertion (the repo
has no existing example, so read the file and assert it lacks the string):
```typescript
import { readFile } from "node:fs/promises";
it("red-flag.ts imports nothing from src/providers (sc-3-8)", async () => {
  const src = await readFile(new URL("./red-flag.ts", import.meta.url), "utf-8");
  expect(src).not.toMatch(/from\s+["'].*providers/);
  expect(src).not.toContain("node:http");
});
```
And `evaluate("")` / `evaluate("   ")` both throw: `expect(() => g.evaluate("", {})).toThrow();`.

### Unit Test Pattern — engine short-circuit + zero-call spies (sc-3-4, sc-3-7)
**Source pattern:** `src/medical/engine.test.ts:80-150` (record consent → construct engine with deps → run with
injected `now` → assert on `result.medicalAnswer` and the audit file). Parametrize over the 5 categories:
```typescript
const CASES = [
  { cat: "cardiac",      prompt: "crushing chest pain radiating to my left arm", hotline: "911" },
  { cat: "stroke",       prompt: "sudden face droop and slurred speech",          hotline: "911" },
  { cat: "anaphylaxis",  prompt: "my throat is closing after a bee sting",        hotline: "911" },
  { cat: "self-harm",    prompt: "I want to kill myself",                          hotline: "988" },
  { cat: "overdose",     prompt: "I think I took too many pills, an overdose",     hotline: "988" },
];
for (const { cat, prompt, hotline } of CASES) {
  it(`short-circuits ${cat} with 0 LLM/numerics calls (sc-3-4)`, async () => {
    // record consent in tmpDir2 first (Gate 1 must pass), then:
    const llmSpy: LLMClient = { chat: vi.fn() };
    const numericsSpy = vi.fn();
    const engine = new MedicalSopEngine({ auditLog, consentGate: gate, disclaimer, llmClient: llmSpy, numerics: numericsSpy });
    const result = await engine.run(prompt, tmpDir2, config, { now: "2026-06-16T10:00:00.000Z" });
    const answer = (result as PipelineResult & { medicalAnswer: MedicalAnswer }).medicalAnswer;
    expect(answer.shortCircuit).toBe(true);
    expect(answer.body).toContain(hotline);
    expect(llmSpy.chat).not.toHaveBeenCalled();
    expect(numericsSpy).not.toHaveBeenCalled();
    // sc-3-7: audit file has a 'short-circuit' entry with ruleId + versions, no prompt text:
    const bytes = await readFile(join(tmpDir2, ".bober", "medical", "audit-2026-06-16.jsonl"), "utf-8");
    const sc = bytes.split("\n").filter(Boolean).map(l => JSON.parse(l)).find(e => e.event === "short-circuit");
    expect(sc.ruleId).toBeTruthy();
    expect(sc.rulesetVersion).toBeTruthy();
    expect(sc.patternsetVersion).toBe(PATTERNSET_VERSION);
    expect(bytes).not.toContain(prompt.slice(0, 8)); // no prompt text leaked
  });
}
```
**Runner:** vitest. **Assertion style:** `expect(...).toEqual/.toBe/.not.toHaveBeenCalled`.
**Mock approach:** `vi.fn()` for spies; module mocks `vi.mock("../utils/logger.js", ...)` + 
`vi.mock("../orchestrator/workflow/eligibility.js", ...)` already at top of `engine.test.ts:7-14` — keep them.
**File naming:** collocated `*.test.ts`. **Setup/teardown:** `mkdtemp(join(tmpdir(),"bober-medical-eng-"))` in
`beforeEach`, `rm(..., {recursive,force})` in `afterEach` (engine.test.ts:72-78).

### E2E Test Pattern
Not applicable — no Playwright/E2E surface for this pure-logic sprint.

---

## 8. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/medical/team.ts` | `buildMedicalGuardrails` (rewritten) | medium | `team.test.ts:30-50` asserts guardrails is defined, exposes `rulesetVersion` (string) + `evaluate` (fn), AND `evaluate("what is blood pressure?", {})` ⇒ `allow`. The real impl MUST still allow that benign prompt. |
| `src/medical/engine.ts` | Gate 2 inserted after consent | high | The existing `engine.test.ts` allow-path tests (lines 80-110, 232-259) run benign prompts (`"test"`, `"what vitamins should I take?"`, `"test prompt"`) — these must NOT trip the detector and must still reach `success:true`. Verify your patterns don't match them. |
| `src/orchestrator/workflow/selector.ts` | `new MedicalSopEngine()` | high | Zero-arg ctor MUST stay. Adding optional deps fields is safe; do NOT add required ctor args. |
| `src/teams/registry.ts:62` | `team.guardrails` slot (typed `unknown`) | low | Slot is `unknown` — type-compatible regardless. No change needed. |

### Existing Tests That Must Still Pass
- `src/medical/team.test.ts` — asserts the guardrails slot shape + benign `allow` (lines 30-50). The rewritten
  `buildMedicalGuardrails` must keep `evaluate("what is blood pressure?", {}) ⇒ allow` and a string
  `rulesetVersion`. NOTE: it only checks `typeof rulesetVersion === "string"`, so changing `"0.0.0"` →
  `"guardrail-2026.06.16"` is safe.
- `src/medical/engine.test.ts` — consent fail-closed (sc-2-4), PHI-free audit (sc-2-7), disclaimer footer
  (sc-2-8), deterministic timestamp tests. Gate 2 runs AFTER consent, so the no-consent refuse path is
  unchanged. The consented benign-prompt tests must still reach the allow path (pick benign prompts that don't
  match red-flag patterns).
- `src/medical/audit.test.ts` / `consent.test.ts` / `disclaimer.test.ts` — untouched modules; must stay green.
- The `rulesetVersion: "0.0.0"` literals in those tests are TEST-LOCAL values passed into
  `recordConsent`/`append` — they are NOT assertions on the GuardrailSet version, so the new
  `GUARDRAIL_RULESET_VERSION` does not conflict.

### Features That Could Be Affected
- **Consent gate (Gate 1, S2)** — shares `engine.run`. Verify consent STILL fires before the guardrail (a
  no-consent emergency prompt must refuse via Gate 1, never reach Gate 2). `evaluatorNotes` requires this.
- **Programming team / `ts|skill|workflow` engines** — byte-zero impact; `red-flag.ts`/`guardrails.ts` are new
  files only imported by `engine.ts`/`team.ts`. No shared edges.

### Recommended Regression Checks
1. `npm run build` (sc-3-1) — zero TS errors.
2. `npm run typecheck` (sc-3-2) — strict-mode zero errors.
3. `npx vitest run src/medical/` — all medical tests green (new + S1/S2).
4. `npx vitest run` — full suite green (confirm no programming-team regression).

---

## 9. Implementation Sequence

1. **`src/medical/red-flag.ts`** — pure detector + `PATTERNSET_VERSION`. No imports. Conservative per-category
   regex/phrase rules; order self-harm/overdose so the 988 categories resolve correctly.
   - Verify: `new RedFlagDetector().detect(x)` returns synchronously; benign prompt ⇒ `{category:"none"}`.
2. **`src/medical/red-flag.test.ts`** — determinism (deep-equal twice), synchronous (not Promise), 5 category
   hits + a benign miss, no-provider-import source assertion (sc-3-5, sc-3-8 detector half).
   - Verify: `npx vitest run src/medical/red-flag.test.ts`.
3. **`src/medical/guardrails.ts`** — `MedicalGuardrails` wrapping the detector; `GUARDRAIL_RULESET_VERSION`;
   `escalationFor` (911/988 fixed strings); throw on empty/whitespace; allow on `none`.
   - Verify: `evaluate("")` throws; `evaluate("what is blood pressure?", {})` ⇒ `allow`.
4. **`src/medical/guardrails.test.ts`** — 5 categories ⇒ short-circuit with right hotline; empty-prompt throws;
   benign ⇒ allow; no-provider-import source assertion (sc-3-8).
   - Verify: `npx vitest run src/medical/guardrails.test.ts`.
5. **`src/medical/team.ts`** — replace the stub `buildMedicalGuardrails` body to `return new MedicalGuardrails()`
   (import from `./guardrails.js`); drop the local `MEDICAL_RULESET_VERSION` allow-only impl.
   - Verify: `npx vitest run src/medical/team.test.ts` (benign allow + slot shape still pass).
6. **`src/medical/engine.ts`** — EXTEND `MedicalSopDeps` (`guardrails`, `llmClient`, `numerics`); resolve the
   guardrails dep (`?? new MedicalGuardrails()`); insert Gate 2 after consent (after line 107); short-circuit
   returns canned `MedicalAnswer` + appends `short-circuit` audit entry with `ruleId`/`rulesetVersion`/
   `patternsetVersion`; allow falls through to the existing placeholder path. Hold `llmClient`/`numerics`
   references but do NOT call them on short-circuit.
   - Verify: zero-arg ctor still compiles; `selector.ts` unaffected.
7. **`src/medical/engine.test.ts`** — add parametrized 5-category short-circuit tests with INJECTED `llmSpy` +
   `numericsSpy` asserted never called (carry-forward #1); audit `short-circuit` entry assertion (sc-3-7);
   "none proceeds to allow" (sc-3-6); confirm consent-first ordering still holds.
   - Verify: `npx vitest run src/medical/engine.test.ts`.
8. **Run full verification** — `npm run build`, `npm run typecheck`, `npx vitest run`.

---

## 10. Pitfalls & Warnings

- **Hollow spy (carry-forward #1):** Do NOT repeat S2's mistake. The `llmSpy`/`numericsSpy` MUST be injected via
  the new `MedicalSopDeps` slots; otherwise `not.toHaveBeenCalled()` is meaningless. See Section 6.
- **Benign engine-test prompts:** existing `engine.test.ts` allow-path tests use `"test"`, `"test prompt"`,
  `"what vitamins should I take?"`. Make sure NONE of your red-flag patterns match these (e.g. don't match a
  bare `"too much"`/`"pain"` substring that benign text could contain) — or you'll break S2 tests.
- **`team.test.ts:48` benign-allow contract:** `evaluate("what is blood pressure?", {})` MUST stay `allow`.
  Word-boundary "chest pain" must NOT fire on "blood pressure".
- **Circular import:** default the engine's guardrails to `new MedicalGuardrails()` from `./guardrails.js`,
  NOT via `team.ts` (which pulls in `resolveRoleProviders`/team graph). `team.ts` imports `guardrails.ts`, never
  the reverse.
- **No provider/network import in red-flag.ts / guardrails.ts** (sc-3-8). Detection is local + deterministic
  (ADR-2). No `src/providers/*`, no `node:http`, no async.
- **Audit is IDs/enums only** (types.ts:76, audit.test.ts:94): the `short-circuit` entry carries ONLY
  `tIso`, `event`, `ruleId`, `rulesetVersion`, `patternsetVersion`. NEVER put `cannedResponse` or prompt text in
  the audit entry. (sc-3-7 reads the file and forbids prompt text.)
- **`.js` import extensions (NodeNext):** import `./red-flag.js`, `./guardrails.js`, `./types.js`,
  `../providers/types.js` — even though the source files are `.ts`.
- **Injected `now`:** the short-circuit audit entry uses `tIso: now` from `opts.now`; tests must inject it
  (carry-forward #2). Don't read the wall clock.
- **Consent ordering invariant:** Gate 2 goes AFTER `engine.ts:107` (the `if (!hasConsent)` return). A
  no-consent emergency prompt must still refuse via Gate 1 and never reach the detector.
- **`GuardrailContext` is `{}`:** pass an empty object literal `{}` from the engine; do not invent context
  fields (real fields are deferred).
