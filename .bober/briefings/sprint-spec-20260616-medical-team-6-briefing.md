# Sprint Briefing: EgressGuard + medications-in-FactStore + full SOP wiring (zero-egress end-to-end)

**Contract:** sprint-spec-20260616-medical-team-6
**Generated:** 2026-06-16T00:00:00Z

> Largest / most integration-heavy sprint of Phase 6. This wires the COMPLETE ordered SOP into
> `MedicalSopEngine.run`, makes zero-egress the CODE-ENFORCED default (two opt-in axes, both `false`),
> adds a scoped ESLint network boundary over `src/medical/**`, and reads medications from the
> bi-temporal `FactStore` (NEVER `HealthDataStore`). All success criteria are additive: S1–S5
> behavior and the programming team must stay byte-identical.

---

## 0. The exact SOP order to wire (memorize this)

From the architecture data-flow (`.bober/architecture/arch-20260616-medical-team-architecture.md:264-285`):

```
GATE 1  ConsentGate.hasConsent ........... fail-closed (ALREADY wired, engine.ts:82-116)
GATE 2  GuardrailSet.evaluate → RedFlag ... 0-LLM short-circuit (ALREADY wired, engine.ts:121-157)
        ── below is the NEW allow-path this sprint replaces engine.ts:159-192 ──
(3)     NumericsQueryLayer.getMetric ....... deterministic compute, NO LLM (S4 layer)
(4)     FactStore.getActiveFacts ........... active medications (ADR-7, value-of-record)
GATE 3  EgressGuard.isAllowed("literature-retrieval")  ... default FALSE
(5)     LiteratureRetriever.retrieve ....... returns {disabled} synchronously when axis off → ABSTAIN
(6)     DisclaimerComposer.footer .......... (already obtained at engine.ts:79)
(7)     AuditLog.append("answer" | "abstain")
(8)     return PipelineResult & { medicalAnswer }
```

**HIGHEST-RISK INVARIANT (sc-6-8):** With both axes off, NO LLM call, NO numerics-network, and NO
network module may be reached. Numerics is pure/sync (`numerics.ts:161` "No async, no fs, no network").
The literature path must short-circuit to `{disabled}` BEFORE any `medline-source` network code (which
does not exist yet). The gates (consent, red-flag) already guarantee 0 downstream calls on their
branches — do NOT move any numerics/meds/egress work above them.

---

## 1. Target Files

### src/medical/egress.ts (create)

**Directory pattern:** `src/medical/*.ts` — one class per file, kebab-case filename, leading JSDoc
block citing the sprint/ADR, named export of the class. See `disclaimer.ts:1-26` (smallest exemplar).

**Most similar existing file:** `src/medical/disclaimer.ts` (pure, no I/O, versioned constant, named class export).

**Authoritative interface** (architecture `arch-20260616-medical-team-architecture.md:131-140`):
```typescript
type EgressAxis = "cloud-inference" | "literature-retrieval"; // both default false
interface EgressGuard {
  isAllowed(axis: EgressAxis): boolean;
  assertAllowed(axis: EgressAxis): void; // throws if not opted in
}
```

**Structure template (mirror disclaimer.ts shape):**
```typescript
/** EgressGuard — two independently opt-in egress axes, both default false (Phase 6, Sprint 6; ADR-6). */
import type { BoberConfig } from "../config/schema.js";

/** The two independent egress axes. Both default FALSE (code-enforced zero-egress, ADR-6). */
export type EgressAxis = "cloud-inference" | "literature-retrieval";

export class EgressGuard {
  // Read flags from config (default false). Independent axes — enabling one does NOT enable the other.
  constructor(private readonly cloudInference: boolean, private readonly literatureRetrieval: boolean) {}

  /** Build from BoberConfig medical section; both axes default false when absent. */
  static fromConfig(config: BoberConfig): EgressGuard {
    const med = config.medical;                       // see §5 — add MedicalSectionSchema (optional)
    return new EgressGuard(med?.egress?.cloudInference ?? false, med?.egress?.literatureRetrieval ?? false);
  }

  isAllowed(axis: EgressAxis): boolean {
    return axis === "cloud-inference" ? this.cloudInference : this.literatureRetrieval;
  }

  assertAllowed(axis: EgressAxis): void {
    if (!this.isAllowed(axis)) throw new Error(`Egress axis '${axis}' not enabled`);
  }
}
```
**Rule:** `EgressGuard.ts` itself has NO network import — it is a plain decision object. EgressAxis values
are EXACTLY `"cloud-inference"` and `"literature-retrieval"` (string-for-string; tested by sc-6-5).
`fromConfig` keeps the engine's zero-arg constructor intact (see §8 wiring note).

---

### src/medical/retrieval/medline-source.ts (create — the ONE sanctioned network file)

**This is the SINGLE file the ESLint exception un-restricts.** It is the future home of the real
MedlinePlus network call (S7). THIS sprint it has NO network import and returns abstain only.

**Structure template:**
```typescript
/** MedlineSource — the ONLY medical file allowed network imports (ADR-6 exception). S7 adds the real call. */
// NO network import yet — Sprint 7 adds the MedlinePlus fetch here under EgressGuard.assertAllowed.

export type RetrievalOutcome =
  | { kind: "disabled" }
  | { kind: "abstain"; reason: string }
  | { kind: "grounded"; passages: string[] };   // S7 only

export class MedlineSource {
  /** Stub this sprint: no network. Returns abstain. The live source call lands in S7. */
  async fetchPassages(_query: string): Promise<RetrievalOutcome> {
    return { kind: "abstain", reason: "literature source not implemented (Sprint 7)" };
  }
}
```
**Rule:** Define `RetrievalOutcome` HERE (it is the literature module's shared type) — do NOT add a
`RetrievalOutcome` to the top-level `types.ts` egress block unless you prefer; either is fine, but keep
it imported by both `literature.ts` and `medline-source.ts` from one place.

---

### src/medical/retrieval/literature.ts (create — LiteratureRetriever orchestration)

**Authoritative interface** (`arch-20260616-medical-team-architecture.md:121-129`):
```typescript
interface LiteratureRetriever {
  retrieve(query: string): Promise<RetrievalOutcome>;          // disabled | abstain | grounded
  synthesize(query: string, outcome: RetrievalOutcome, llm: LLMClient): Promise<MedicalAnswer>;
}
```

**Structure template (the egress gate lives HERE):**
```typescript
/** LiteratureRetriever — checks the literature-retrieval axis; returns {disabled} sync when off (ADR-6). */
import type { EgressGuard } from "../egress.js";
import { MedlineSource, type RetrievalOutcome } from "./medline-source.js";

export class LiteratureRetriever {
  constructor(private readonly egress: EgressGuard, private readonly source = new MedlineSource()) {}

  /** SYNCHRONOUS short-circuit: if the axis is off, return {disabled} — NO network attempt. */
  async retrieve(query: string): Promise<RetrievalOutcome> {
    if (!this.egress.isAllowed("literature-retrieval")) return { kind: "disabled" };
    return this.source.fetchPassages(query);   // S7: real network behind assertAllowed
  }
}
```
**Rule:** The `isAllowed("literature-retrieval")` check MUST precede `this.source.*`. With the axis off
the function returns before `MedlineSource` is even consulted — proves zero-egress.

---

### src/medical/engine.ts (modify) — the integration heart

**Relevant sections that CHANGE:**

`run` signature today renames `_config` → `config` (it is now USED to build EgressGuard) — lines 63-71:
```typescript
async run(
  userPrompt: string,
  projectRoot: string,
  config: BoberConfig,          // was _config — now consumed (EgressGuard.fromConfig)
  opts?: { runId?: string; now?: string },
): Promise<PipelineResult> {
  const now = opts?.now ?? new Date().toISOString();   // keep documented fallback (engine.ts:69-71)
```

`MedicalSopDeps` (engine.ts:29-39) — extend ADDITIVELY with new optional slots (see §5 for exact shape):
```typescript
export interface MedicalSopDeps {
  auditLog?: AuditLog;
  consentGate?: ConsentGate;
  disclaimer?: DisclaimerComposer;
  guardrails?: GuardrailSet;
  llmClient?: LLMClient;
  numerics?: () => unknown;   // ← see CARRY-FORWARD note: the spies test still relies on this slot type
  // NEW (S6):
  egress?: EgressGuard;
  literature?: LiteratureRetriever;
  facts?: FactStore;          // injected FactStore for medications (tests pass :memory:)
}
```

**The block to REPLACE is the allow-path stub at engine.ts:159-192** (everything after
`// verdict.kind === "allow"`). Replace it with the ordered SOP (3)-(8). Keep the consent block
(82-116) and the red-flag block (121-157) EXACTLY as-is.

**Imports this file uses (existing):** `AuditLog`, `ConsentGate`, `DisclaimerComposer`, `MedicalGuardrails`,
`createSpec`, types `GuardrailSet`/`MedicalAnswer`/`LLMClient`/`BoberConfig`/`PipelineResult`.
**New imports to add:** `EgressGuard` from `./egress.js`, `LiteratureRetriever` from `./retrieval/literature.js`,
`NumericsQueryLayer` from `./numerics.js`, `HealthDataStore` from `./health-store.js`,
`FactStore` from `../state/facts.js`, `MetricWindow`/`NumericResult` types from `./types.js`.

**Imported by:** `src/orchestrator/workflow/selector.ts:7,126` (constructs `new MedicalSopEngine()` zero-arg —
DO NOT break this), `src/medical/engine.test.ts`.

**Test file:** `src/medical/engine.test.ts` (exists — 471 lines; see §6 + §7 carry-forwards).

---

### eslint.config.js (modify)

**Relevant section — the telemetry precedent to mirror (lines 42-69):** see §2 for the exact diff.

**Imported by:** the lint runner only. No TS imports.

---

### src/medical/egress.test.ts (create)

**Most similar existing test:** `src/medical/disclaimer.test.ts` (pure-class unit test, no fs) and
`src/state/facts.test.ts` (`:memory:` + `afterEach close`). See §6 for the template.

---

## 2. ESLint scoped-boundary diff (mirror the telemetry block)

**Source precedent:** `eslint.config.js:42-69` (the `src/telemetry/**/*.ts` block) and the rationale
comment in `src/telemetry/emit.ts:11-15` ("NETWORK EGRESS: forbidden by design ... enforced by ESLint
no-restricted-imports rule scoped to src/telemetry/**"). ADR-6 (`arch-20260616-medical-team-adr-6.md:3-5,17`)
mandates copying this exact pattern.

**Add TWO new blocks AFTER the telemetry block (after line 69), BEFORE the `src/**/*.js` block (line 70).**
Block order matters: the broad medical rule first, then the single-file exception override (ESLint flat
config applies later matching blocks last; the exception must come AFTER the restriction).

```javascript
  {
    // Sprint 6 (ADR-6): code-enforced zero-egress for the medical tree.
    // Any network/socket import inside src/medical/ is a lint error EXCEPT in the one
    // sanctioned retrieval file (src/medical/retrieval/medline-source.ts) — see override below.
    files: ["src/medical/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "undici",     message: "Network access forbidden in medical module (ADR-6 — zero-egress default)" },
            { name: "got",        message: "Network access forbidden in medical module" },
            { name: "axios",      message: "Network access forbidden in medical module" },
            { name: "node-fetch", message: "Network access forbidden in medical module" },
          ],
          patterns: [
            {
              group: ["http", "https", "net", "tls", "node:http", "node:https", "node:net", "node:tls"],
              message: "Network/socket imports forbidden in src/medical/ — ADR-6 egress only via the sanctioned retrieval file",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "Network access forbidden in medical module — egress only via the sanctioned retrieval file" },
      ],
    },
  },
  {
    // ADR-6 single exception: the ONE designated retrieval network file. S7 puts the real MedlinePlus call here.
    files: ["src/medical/retrieval/medline-source.ts"],
    rules: {
      "no-restricted-imports": "off",
      "no-restricted-globals": "off",
    },
  },
```

**Gotchas:**
- The contract (sc-6-6 / generatorNotes) names the modules: `undici, got, axios, node-fetch` as `paths`
  and `node:http, node:https, node:net, node:tls` as `patterns`. The telemetry block also lists bare
  `http/https/net/tls/dgram` and `node:dgram`. Include both the bare and `node:` forms (mirror line 58);
  `dgram` is optional but harmless to include.
- `*.test.ts` under `src/medical/` ARE matched by `src/medical/**/*.ts` and so are covered by the
  restriction. That is the desired posture (generatorNotes: "prefer covered"). The egress/literature
  tests must NOT import `undici/fetch` directly — they go through `MedlineSource`/`LiteratureRetriever`.
  If a test needs a network spy, monkeypatch a global in the test body (assignment is fine; only `import`
  and reading the `fetch` global as an identifier are restricted) OR keep the spy on the injected source.
- Since `medline-source.ts` has NO network import THIS sprint, the exception override is currently inert —
  reserve it now so S7 drops the real import in without a lint change. Lint MUST be green now (sc-6-3).

**To self-verify sc-6-6 without shipping a fixture:** temporarily add `import "undici";` to e.g.
`src/medical/egress.ts`, run `npm run lint` (expect a failure citing the medical message), then REVERT.
The contract explicitly allows "verified by the rule config + a focused test/fixture OR by reviewing the config".

---

## 3. FactStore.getActiveFacts medication read (ADR-7)

**Source:** `src/state/facts.ts:208-248` (the `getActiveFacts` overloads) and ADR-7
(`arch-20260616-medical-team-adr-7.md:3,17`).

**Signature (facts.ts:213):**
```typescript
getActiveFacts(scope: string, subject?: string, predicate?: string): FactRecord[]
// Active = t_invalidated IS NULL (bi-temporal, invalidate-don't-delete; facts.ts:211)
```

**`FactRecord` shape (facts.ts:37-49):** `{ id, scope, subject, predicate, value, confidence, sourceRunId,
tValid, tInvalid, tCreated, tInvalidated }`. The medication name lives in `value`; `predicate` is the
relation. ADR-7:17 specifies the exact call:
```typescript
FactStore.getActiveFacts(scope, subject, "takes-medication")
```

**How the engine reads medications (NEVER HealthDataStore — sc-6-7 / ADR-7):**
```typescript
const MEDICAL_SCOPE = "medical";          // matches Team.memoryNamespace "medical" (team.ts:53)
const MEDICATION_PREDICATE = "takes-medication";   // ADR-7 line 17
const SUBJECT = "patient";                // single-subject; pick a stable subject string

const facts = this.deps?.facts ?? new FactStore(factsDbPath(projectRoot, MEDICAL_SCOPE));
const activeMeds = facts.getActiveFacts(MEDICAL_SCOPE, SUBJECT, MEDICATION_PREDICATE);
// activeMeds.map(f => f.value) → the current medication-list value-of-record
```
- `factsDbPath(projectRoot, "medical")` (facts.ts:77-79) resolves `.bober/memory/medical/facts.db`
  (memoryDir maps a non-"programming" namespace into a subdir, `memory.ts:27-28`). Use the SAME
  namespace as `buildMedicalTeam`'s `memoryNamespace: "medical"` (team.ts:53).
- A test (sc-6-7) seeds an in-memory FactStore and INJECTS it via `deps.facts`:
  ```typescript
  const facts = new FactStore(":memory:");
  facts.insertFact({ scope: "medical", subject: "patient", predicate: "takes-medication",
    value: "metformin 500mg", confidence: 1, sourceRunId: null,
    tValid: "2026-06-16T10:00:00.000Z", tCreated: "2026-06-16T10:00:00.000Z" });
  const engine = new MedicalSopEngine({ /* ...consent... */ facts });
  ```
  Then assert the returned MedicalAnswer surfaces/uses the active med, AND assert NO medication row was
  written to a HealthDataStore (i.e. the engine never calls `HealthDataStore.upsertObservations` with a
  medication — the simplest assertion is that the engine reads from `facts.getActiveFacts` (spy on it)
  and that the answer body references the FactStore value, never a HealthDataStore row).
- `getActiveFacts` excludes invalidated facts automatically (facts.test.ts:32-49 proves invalidate →
  `getActiveFacts` length 0). So a discontinued med (superseded via `reconcile.ts:73`) won't surface —
  no extra filtering needed.
- `FactStore` is SYNC (better-sqlite3, facts.ts:136-141) — NO `await` on `getActiveFacts`.

**DO NOT** add a medication column/table to `HealthDataStore` (`health-store.ts:115-148` schema is
observations/labs/kv only — leave it untouched). ADR-7:19 "HealthDataStore never stores medication-list state."

---

## 4. The full SOP in run() — exact replacement for engine.ts:159-192

Replace the allow-path stub (lines 159-192) with the ordered block below. Keep lines 82-116 (consent)
and 121-157 (red-flag) verbatim above it.

```typescript
  // verdict.kind === "allow" → proceed to the full SOP (S6).
  const consentRecord = await consentGate.current();
  const rulesetVersion = consentRecord?.rulesetVersion;

  // ── (3) Numerics (deterministic compute, NO LLM) ──────────────────
  // Derive a minimal MetricWindow from the prompt (full NL parse is out of scope; S4 proved correctness).
  // numericsSpy injection: when deps.numerics is provided (tests), the engine MUST call it so the
  // spy assertions are real (see carry-forward A). In production, build NumericsQueryLayer over a
  // HealthDataStore at the medical namespace.
  let numericResult: NumericResult | null = null;
  if (isNumericQuestion(userPrompt)) {           // small deterministic detector (e.g. /average|mean|max|latest|trend/i)
    if (this.deps?.numerics) {
      this.deps.numerics();                       // exercise the injected spy (carry-forward A)
    }
    const numerics = /* NumericsQueryLayer over HealthDataStore at medical ns, or a deps seam */;
    const window = deriveWindow(userPrompt, now); // deterministic window from prompt + now
    numericResult = numerics.getMetric(window, derivePrimitive(userPrompt));  // sampleCount 0 ⇒ abstain
  }

  // ── (4) Medications via FactStore.getActiveFacts (ADR-7) ──────────
  const facts = this.deps?.facts ?? new FactStore(factsDbPath(projectRoot, "medical"));
  const activeMeds = facts.getActiveFacts("medical", "patient", "takes-medication");

  // ── GATE 3 + (5) Literature egress gate ───────────────────────────
  const egress = this.deps?.egress ?? EgressGuard.fromConfig(config);
  const literature = this.deps?.literature ?? new LiteratureRetriever(egress);
  const outcome = await literature.retrieve(userPrompt);   // {disabled} sync when axis off → NO network

  // ── (6)+(7)+(8) Compose answer + audit + return ───────────────────
  const abstained = outcome.kind !== "grounded";  // disabled/abstain ⇒ abstained answer this sprint
  const answer: MedicalAnswer = {
    body: composeBody(numericResult, activeMeds, outcome),  // numeric result + meds context, or abstain text
    abstained,
    citations: [],
    disclaimerFooter: footer,
    shortCircuit: false,
  };
  await auditLog.append({ tIso: now, event: abstained ? "abstain" : "answer", rulesetVersion });

  const spec = createSpec("Medical SOP", "Full local SOP turn.", []);
  return { success: true, spec, completedSprints: [], failedSprints: [], duration: 0,
    medicalAnswer: answer } as PipelineResult & { medicalAnswer: MedicalAnswer };
```

**Audit event mapping (types.ts:64-70 `AuditEvent` already has both `"answer"` and `"abstain"`):**
- numeric question answered from compute → `event: "answer"` (sc-6-8)
- literature question with axis off → `outcome.kind === "disabled"` → abstained answer → `event: "abstain"` (sc-6-8)

**Ordering invariant (DO NOT VIOLATE):** numerics (3) and meds (4) run BEFORE the egress gate, but they
are LOCAL (no network, no LLM): `numerics.ts:161` is sync/offline; `FactStore` is local SQLite. The ONLY
egress decision is GATE 3. With `literature-retrieval` off, `retrieve` returns `{disabled}` at
`literature.ts` line 1 of the body — `MedlineSource` is never touched. This is the sc-6-8 guarantee.

**`isNumericQuestion`/`deriveWindow`/`derivePrimitive`/`composeBody`** are small deterministic local
helpers in engine.ts (contract assumption line 79: "minimal NL→query parsing here"). Keep them pure;
no LLM, no regex that touches the network. If the prompt is not numeric, skip (3) and produce an
abstained/general answer — still with footer + audit.

---

## 5. Types & config additions (additive only)

### types.ts (modify, additive)
`MedicalAnswer` (types.ts:39-45) is sufficient as-is for this sprint (body/abstained/citations/
disclaimerFooter/shortCircuit). Optionally add an `EgressAxis` export and a `RetrievalOutcome` union if
you want them centralized — but the briefing recommends defining `EgressAxis` in `egress.ts` and
`RetrievalOutcome` in `medline-source.ts` (co-located with their owners; matches the one-class-per-file
convention in `src/medical/`). Either is acceptable; do NOT alter existing exported type shapes.

### config/schema.ts (modify, additive) — drive the egress axes from config
Mirror `TelemetrySectionSchema` (schema.ts:330-337). Add a `MedicalSectionSchema` with an `egress`
sub-object, both flags default false, and wire it into `BoberConfigSchema` as `.optional()`:
```typescript
export const MedicalSectionSchema = z.object({
  egress: z.object({
    cloudInference: z.boolean().default(false),
    literatureRetrieval: z.boolean().default(false),
  }).optional(),
});
export type MedicalSection = z.infer<typeof MedicalSectionSchema>;
// in BoberConfigSchema (near line 393, with the other optional sections):
//   medical: MedicalSectionSchema.optional(),
```
This keeps `createDefaultConfig` byte-identical (the section is optional and defaults off) — programming
team unaffected (non-goal: "Do not change ts|skill|workflow or programming-team behavior").
`EgressGuard.fromConfig(config)` reads `config.medical?.egress?.{cloudInference,literatureRetrieval} ?? false`.

---

## 6. Testing Patterns

**Runner:** Vitest. **Assertion style:** `expect(...)`. **Mock approach:** `vi.fn()` / `vi.mock(...)`.
**File naming:** co-located `*.test.ts`. **Cleanup:** `afterEach(() => store?.close())` for SQLite,
`mkdtemp`/`rm` for fs (engine.test.ts:74-80).

### EgressGuard unit test (sc-6-5) — template (mirror disclaimer.test.ts style)
```typescript
import { describe, it, expect } from "vitest";
import { EgressGuard } from "./egress.js";

describe("EgressGuard — two independent axes default false (sc-6-5)", () => {
  it("both axes default false; isAllowed returns false", () => {
    const g = new EgressGuard(false, false);
    expect(g.isAllowed("cloud-inference")).toBe(false);
    expect(g.isAllowed("literature-retrieval")).toBe(false);
  });
  it("assertAllowed throws for each axis when off", () => {
    const g = new EgressGuard(false, false);
    expect(() => g.assertAllowed("cloud-inference")).toThrow();
    expect(() => g.assertAllowed("literature-retrieval")).toThrow();
  });
  it("axes are independent: enabling literature does NOT enable cloud", () => {
    const g = new EgressGuard(false, true);
    expect(g.isAllowed("literature-retrieval")).toBe(true);
    expect(g.isAllowed("cloud-inference")).toBe(false);
    expect(() => g.assertAllowed("literature-retrieval")).not.toThrow();
    expect(() => g.assertAllowed("cloud-inference")).toThrow();
  });
  it("fromConfig defaults both false when medical section absent", () => {
    const g = EgressGuard.fromConfig({} as any);   // or createDefaultConfig(...)
    expect(g.isAllowed("cloud-inference")).toBe(false);
    expect(g.isAllowed("literature-retrieval")).toBe(false);
  });
});
```

### Full-SOP zero-egress test (sc-6-8) — engine.test.ts addition
Follow the existing engine.test.ts allow-path pattern (lines 393-424) for consent setup
(`recordTestConsent` helper at engine.test.ts:292-306). Then:
- inject `llmSpy = { chat: vi.fn() }` and assert `llmSpy.chat` NOT called on the disabled path;
- inject a FactStore (`:memory:`) seeded with a `takes-medication` fact (sc-6-7);
- for a numeric prompt ("what was my average resting heart rate last week") seed a HealthDataStore (or
  inject a numerics spy that returns a NumericResult) → assert answer body carries the numeric result
  and audit has an `"answer"` entry (read the jsonl as engine.test.ts:280-285 does);
- for a literature prompt with axis off → assert `literature.retrieve(...)` resolves `{ kind: "disabled" }`
  and the answer is `abstained: true` with an `"abstain"` audit entry;
- network spy: since `medline-source.ts` has no network import, the strongest assertion is that
  `MedlineSource.fetchPassages` is NEVER called on the disabled path (spy the injected source) — that
  proves zero reach. (A global http/https monkeypatch recording zero calls is also acceptable; assign in
  the test body, do not `import` a network module — see §2 lint note.)

### FactStore seed pattern (sc-6-7)
Source: `src/state/facts.test.ts:13-30` — `new FactStore(":memory:")` + `insertFact({...})` +
`getActiveFacts(scope)`; `afterEach(() => store?.close())`.

---

## 7. Carry-forward test cleanups (REQUIRED this sprint)

### Carry-forward A — make the fail-closed spies real (engine.test.ts:117-152)
The `sc-2-4` "fail-closed (no consent)" test (engine.test.ts:117-152) creates `llmSpy`/`numericsSpy`
(lines 123-124) but DOES NOT inject them into the engine ctor (line 131 passes only
`{ auditLog, consentGate, disclaimer }`). The later red-flag tests DO inject them (engine.test.ts:349-355).
Now that `deps.llmClient`/`deps.numerics` exist AND the allow-path actually calls `deps.numerics`
(see §4), inject the spies into the sc-2-4 test ctor and keep the
`expect(llmSpy.chat).not.toHaveBeenCalled()` / `expect(numericsSpy).not.toHaveBeenCalled()` assertions
real. (Type the spy as `LLMClient` like line 346: `const llmSpy: LLMClient = { chat: vi.fn() };`.)

```typescript
// engine.test.ts ~131 — BEFORE:
const engine = new MedicalSopEngine({ auditLog, consentGate, disclaimer });
// AFTER:
const llmSpy: LLMClient = { chat: vi.fn() };
const numericsSpy = vi.fn();
const engine = new MedicalSopEngine({ auditLog, consentGate, disclaimer, llmClient: llmSpy, numerics: numericsSpy });
// (assertions at lines 150-151 already reference llmSpy/numericsSpy — they become meaningful)
```

### Carry-forward B — convert numerics.test.ts source-grep to async readFile (numerics.test.ts:341-356)
The `sc-4-8` "no eval/codegen/subprocess" test uses `readFileSync` (numerics.test.ts:2,346-347).
Convert to `await readFile` from `node:fs/promises` and make the `it(...)` callback async.

```typescript
// numerics.test.ts:2 — BEFORE:  import { readFileSync } from "node:fs";
//                       AFTER:   import { readFile } from "node:fs/promises";
// lines 344-348 — make async and await:
it("numerics.ts and health-store.ts contain no eval/Function/vm/child_process/execa", async () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const numericsSrc = await readFile(join(dir, "numerics.ts"), "utf8");
  const storeSrc = await readFile(join(dir, "health-store.ts"), "utf8");
  // ...rest unchanged...
});
```
(`fileURLToPath`/`dirname`/`join` imports at numerics.test.ts:3-4 stay.)

---

## 8. Engine construction / opts.now wiring

- **Zero-arg constructor preserved.** `selector.ts:124-126` calls `new MedicalSopEngine()` with NO args.
  Do NOT add required constructor params. EgressGuard/Literature/FactStore are built INSIDE `run()` from
  `config`/`projectRoot` (with `deps.*` overrides for tests) — exactly how consent/audit/disclaimer are
  built today (engine.ts:74-77).
- **`config` is now consumed.** Rename the `_config` param to `config` (engine.ts:66) — it feeds
  `EgressGuard.fromConfig(config)`. This is the only signature change and it stays type-compatible
  (`PipelineEngine.run` already declares `config: BoberConfig`).
- **opts.now:** keep the documented wall-clock fallback at engine.ts:69-71 (`opts?.now ?? new Date().toISOString()`).
  Tests ALWAYS inject `now` (engine.test.ts every call passes `{ now: "2026-06-16T..." }`). The new
  `answer`/`abstain` audit entries MUST use `now` (never a fresh `new Date()`), matching the consent/
  short-circuit entries (engine.ts:87,125,166). The S2 "always pass opts.now" intent is satisfied by the
  caller (`runPipeline`/spawn path) continuing to pass a deterministic timestamp; this sprint does not
  need to change the caller — just keep using `now` for every audit append.

---

## 9. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/orchestrator/workflow/selector.ts:7,126` | `MedicalSopEngine` ctor | high | Must stay `new MedicalSopEngine()` zero-arg. If you add required ctor params, this breaks the build. |
| `src/medical/engine.test.ts` | `engine.run` allow-path shape | high | All allow-path tests (lines 82-113, 234-261, 393-424) expect `success:true`, non-empty footer, `shortCircuit:false`. New SOP must preserve those. |
| `eslint.config.js` consumers (lint) | new medical block | medium | A bad glob/rule object fails `npm run lint` for the WHOLE repo. Block order: restriction before exception. |
| `src/config/schema.ts` consumers | `BoberConfigSchema` | medium | New `medical` section MUST be `.optional()` so `createDefaultConfig` and all existing config files still parse. |
| `src/state/facts.ts` | `getActiveFacts` (read-only use) | low | Engine only READS; no schema change. No dependents affected. |
| `src/medical/health-store.ts` | NOT modified | low | Confirm you do NOT add medication storage here (ADR-7). |

### Existing Tests That Must Still Pass
- `src/medical/engine.test.ts` — consent gate (sc-2-4, 117-172), red-flag short-circuit (sc-3-4,
  336-389), benign allow (sc-3-6, 393-424), PHI-free audit (sc-2-7, 176-211), deterministic timestamps
  (266-287), disclaimer footer (215-262). The new allow-path must keep the allow tests green AND the
  carry-forward A injection must keep the no-consent spy assertions green.
- `src/medical/numerics.test.ts` — all 8-primitive + abstain + cross-unit tests (49-339) unchanged;
  only the sc-4-8 source-grep test (341-356) is edited (carry-forward B).
- `src/state/facts.test.ts` — unchanged; engine's read-only `getActiveFacts` use must not regress facts.
- `src/medical/team.test.ts`, `consent.test.ts`, `audit.test.ts`, `disclaimer.test.ts`,
  `guardrails.test.ts`, `red-flag.test.ts`, `health-store.test.ts`, `ingestion.test.ts` — all must
  stay green (S1–S5 untouched).
- Programming-team / selector tests — `selectPipelineEngine` for `"ts"` still returns `TsPipelineEngine`
  (engine.test.ts:60-67); `selectPipelineEngineForTeam` for medical still returns a `MedicalSopEngine`
  (engine.test.ts:50-58).

### Features That Could Be Affected
- **Telemetry egress boundary** — shares the ESLint `no-restricted-imports` mechanism (eslint.config.js:42-69).
  Verify the existing telemetry block is untouched and still green after adding the medical blocks.
- **Config parsing (all teams)** — shares `BoberConfigSchema`. The new optional `medical` section must
  not change defaults for any other section.
- **FactStore / memory (programming scope)** — shares `getActiveFacts`. Medical reads under scope
  `"medical"`; programming uses scope `"programming"` — scope isolation must hold (facts.ts:213 filters by scope).

### Recommended Regression Checks (run after implementation)
1. `npm run build` — zero TS errors (sc-6-1).
2. `npm run typecheck` — zero errors (sc-6-2).
3. `npm run lint` — green INCLUDING the new `src/medical/**` block (sc-6-3, sc-6-6).
4. `npx vitest run src/medical` — all medical tests green (sc-6-4/5/7/8).
5. `npx vitest run src/state/facts.test.ts` — facts unaffected.
6. `npm test` — full suite green; S1–S5 + programming team unchanged.
7. Manual sc-6-6 spot check (optional): add `import "undici";` to `src/medical/egress.ts`, run
   `npm run lint`, confirm it FAILS with the medical message, then REVERT.

---

## 10. Implementation Sequence (dependency-ordered)

1. **src/config/schema.ts** — add optional `MedicalSectionSchema` (egress.cloudInference / egress.literatureRetrieval, default false) + wire into `BoberConfigSchema` as `.optional()`.
   - Verify: `npm run typecheck` clean; `createDefaultConfig` still parses (no test change needed).
2. **src/medical/egress.ts** — `EgressAxis` type + `EgressGuard` (isAllowed/assertAllowed/fromConfig). No network import.
   - Verify: write/run `egress.test.ts` (sc-6-5) — both axes default false, throws, independent.
3. **eslint.config.js** — add the `src/medical/**` restriction block + the `medline-source.ts` exception override (restriction first, exception after). Mirror telemetry 42-69.
   - Verify: `npm run lint` green (boundary inert until a network import appears).
4. **src/medical/retrieval/medline-source.ts** — `RetrievalOutcome` union + `MedlineSource.fetchPassages` returning `{abstain}`. NO network import yet.
   - Verify: typecheck; it is the file the ESLint exception covers.
5. **src/medical/retrieval/literature.ts** — `LiteratureRetriever` checking `isAllowed("literature-retrieval")` → `{disabled}` sync, else delegate to `MedlineSource`.
   - Verify: a quick unit test (axis off ⇒ `{kind:"disabled"}` and source NOT called).
6. **src/medical/engine.ts** — extend `MedicalSopDeps` (egress/literature/facts), rename `_config`→`config`, replace the allow-path stub (159-192) with the ordered SOP (numerics → meds-from-FactStore → egress gate → retrieve → compose → audit answer/abstain). Keep consent (82-116) + red-flag (121-157) verbatim above.
   - Verify: allow-path tests (engine.test.ts:82-113,393-424) still pass; selector zero-arg ctor still compiles.
7. **Carry-forward A** — inject `llmSpy`/`numericsSpy` into the sc-2-4 no-consent test ctor (engine.test.ts:131).
   - Verify: assertions at 150-151 now reference injected spies and pass.
8. **Carry-forward B** — convert numerics.test.ts:341-356 to `await readFile` (async it).
   - Verify: sc-4-8 test still green.
9. **New tests** — egress.test.ts (sc-6-5, done in step 2), medications-from-FactStore (sc-6-7), full zero-egress SOP turn (sc-6-8: numeric answer+footer+audit; literature disabled+abstain; llm spy 0 calls; source spy 0 calls).
   - Verify: `npx vitest run src/medical`.
10. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run lint`, `npm test` (all green; S1–S5 + programming team unchanged).

---

## 11. Pitfalls & Warnings

- **ESLint block order.** In flat config the LAST matching block wins per-rule. The `medline-source.ts`
  exception override MUST come AFTER the `src/medical/**` restriction, or the exception is overridden by
  the restriction. (Telemetry has only one block; you are adding TWO — order matters.)
- **`*.test.ts` are matched by `src/medical/**/*.ts`.** Your egress/literature tests cannot `import` a
  network module or read the `fetch` global as an identifier. Use injected source/llm spies; if you must
  monkeypatch, assign to a global in the test body (assignment is not restricted; only `import` and
  reading the `fetch` global are).
- **Do NOT break the zero-arg `new MedicalSopEngine()`** at `selector.ts:126`. Build deps inside `run()`.
- **Do NOT call numerics/meds/egress/LLM above the gates.** Consent (82-116) and red-flag (121-157) must
  remain the first two operations; the SOP additions go ONLY in the allow-path. sc-6-8 + ADR-2 require
  0 downstream work on a short-circuit/refuse.
- **FactStore is synchronous** (better-sqlite3) — no `await` on `getActiveFacts`/`insertFact`. The async
  keyword on `run` is for `auditLog.append`/`literature.retrieve`/`consentGate.*` only.
- **Medications NEVER in HealthDataStore** (ADR-7:19). Do not extend `health-store.ts` schema
  (`health-store.ts:120-147`). The sc-6-7 test must assert no medication row is written there.
- **`literature.retrieve` returns `{disabled}` BEFORE touching `MedlineSource`** — this is THE zero-egress
  proof. If you call the source first and check the axis inside it, a spy would record a call.
- **Audit entries use `now`** (the injected ISO), never a fresh `new Date()`. PHI rule (types.ts:84,
  audit.ts:14-19): only IDs/enums in audit entries — never the prompt or a health value. The new
  `answer`/`abstain` entries carry only `tIso`, `event`, optional `rulesetVersion`.
- **`config` rename:** changing `_config` → `config` removes the unused-var underscore — fine, it is now
  used. Don't leave it `_config` and also reference it (the `argsIgnorePattern: "^_"` rule, eslint.config.js:35,
  is about unused args; a used `_config` reads oddly but is legal — prefer renaming to `config`).
- **`medline-source.ts` exception is inert this sprint** (no network import yet). That is intentional —
  reserve the path so S7 adds the real MedlinePlus call with NO eslint change. Lint must still be green now.
