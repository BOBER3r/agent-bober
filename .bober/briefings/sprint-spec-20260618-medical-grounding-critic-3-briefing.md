# Sprint Briefing: Configurable model + cloud-inference egress gating + audit verdict

**Contract:** sprint-spec-20260618-medical-grounding-critic-3
**Generated:** 2026-06-18T16:30:00Z

---

## 0. Goal in one paragraph

Make the medical synthesis/critic model+provider configurable via a NEW optional
`config.medical.inference:{provider?,endpoint?,model?}` block, but gate any CLOUD use behind the
EXISTING `cloud-inference` egress axis (default false). Add a resolver `buildMedicalInferenceClient(config, egress)`
in a NEW `src/medical/inference.ts` that fails CLOSED to the local Ollama default when cloud is not opted in.
Wire the engine grounded branch to use it (replacing the hardcoded `createClient` at `engine.ts:402`),
thread the resolved model into `synthesizeGrounded`, WIDEN `synthesizeGrounded`'s return to carry a
three-way verdict, and append that verdict as an optional IDs/enums-only `criticVerdict` field on the
`AuditEntry` (0600 preserved, no PHI). Back-compat MUST be byte-identical when no inference config is set.

---

## 1. Target Files

### src/config/schema.ts (modify)

**Relevant section — `MedicalSectionSchema` (lines 374-389):**
```ts
// ── Medical Section (Phase 6, Sprint 6 — two egress axes default off) ──

export const MedicalSectionSchema = z.object({
  /** Egress opt-in axes (ADR-6). Both default false — zero outbound bytes by default. */
  egress: z
    .object({
      /** When true, cloud inference synthesis is permitted. Default false. */
      cloudInference: z.boolean().default(false),
      /** When true, literature retrieval (MedlinePlus) is permitted. Default false. */
      literatureRetrieval: z.boolean().default(false),
      /** When true, WHOOP device-connection egress is permitted (ADR-1). Default false. */
      deviceConnection: z.boolean().default(false),
    })
    .optional(),
});
export type MedicalSection = z.infer<typeof MedicalSectionSchema>;
```

**EXACT block to ADD** — a sibling of `egress`, INSIDE the `z.object({...})`, all-optional, no `.default()`
(unlike egress, these are pure overrides; absence = local default resolved at runtime):
```ts
  /**
   * Optional synthesis/critic model override (Sprint 3 — grounding-critic).
   * Absent => local Ollama default (openai-compat http://localhost:11434/v1, llama3).
   * A CLOUD provider here is only honoured when egress.cloudInference is true (fail-closed otherwise).
   */
  inference: z
    .object({
      provider: z.string().optional(),
      endpoint: z.string().optional(),
      model: z.string().optional(),
    })
    .optional(),
```
Leave the `egress` block UNTOUCHED. The whole config flows through `BoberConfigSchema` (schema.ts:421
`medical: MedicalSectionSchema.optional()`), and `EgressGuard.fromConfig` already reads
`config.medical.egress` — that path is unchanged.

**Imported by (blast radius for config.medical):**
- `src/medical/egress.ts:26` — `const med = config.medical;` (reads only `.egress`, NOT `.inference`; unaffected)
- `src/config/schema.ts:421` — `medical: MedicalSectionSchema.optional()`
- The new `src/medical/inference.ts` will read `config.medical?.inference`

**Test file:** schema has tests elsewhere; the inference block is exercised via `src/medical/inference.test.ts` (new) and `engine.test.ts`.

---

### src/medical/inference.ts (create)

**Directory pattern:** files in `src/medical/` are kebab/lowercase `.ts`, ESM with `.js` import suffixes,
Unicode `── section ──` headers, `import type` for types, named exports. See `src/medical/egress.ts`
(class + static `fromConfig`) and `src/medical/audit.ts` for the house style.

**Most similar existing file for the createClient seam:** `src/medical/engine.ts:36,402` — the ONLY other place
under `src/medical/` that imports `createClient`. Mirror that import exactly:
`import { createClient } from "../providers/factory.js";`

**Structure template (the full resolver):**
```ts
/** Medical inference resolver — local-default fail-closed; cloud only behind cloud-inference (Sprint 3). */
import type { BoberConfig } from "../config/schema.js";
import type { LLMClient } from "../providers/types.js";
import type { EgressGuard } from "./egress.js";
import { createClient } from "../providers/factory.js";

// ── Local default (non-egressing) ────────────────────────────────────
/** The local Ollama default — provider openai-compat, localhost endpoint, llama3. Treated as non-egressing. */
const LOCAL = {
  provider: "openai-compat",
  endpoint: "http://localhost:11434/v1",
  model: "llama3",
} as const;

/** Injectable factory seam so tests can spy without real network. Defaults to the real createClient. */
export type ClientFactory = typeof createClient;

// ── buildMedicalInferenceClient ──────────────────────────────────────
/**
 * Resolve the synthesis/critic LLMClient + model from config, gated by cloud-inference.
 *
 * - No inference config => exact local default (back-compat, byte-identical to engine.ts:402).
 * - inference points at the local provider/endpoint => used as-is (non-egressing).
 * - inference points at a CLOUD provider/endpoint AND cloud-inference is OFF => FAIL CLOSED to local.
 * - cloud config AND cloud-inference is ON => the configured cloud client/model is built.
 *
 * The local-vs-cloud decision lives ONLY here; createClient is the sole client-construction seam.
 */
export function buildMedicalInferenceClient(
  config: BoberConfig,
  egress: EgressGuard,
  factory: ClientFactory = createClient,
): { client: LLMClient; model: string } {
  const inf = config.medical?.inference;

  const wantProvider = inf?.provider ?? LOCAL.provider;
  const wantEndpoint = inf?.endpoint ?? LOCAL.endpoint;
  // "Local" = openai-compat against a localhost endpoint. Anything else is treated as cloud.
  const isLocal = wantProvider === LOCAL.provider && wantEndpoint.includes("localhost");

  // FAIL CLOSED: cloud config requested but the cloud-inference axis is not opted in.
  if (!isLocal && !egress.isAllowed("cloud-inference")) {
    return {
      client: factory(LOCAL.provider, LOCAL.endpoint, undefined, LOCAL.model),
      model: LOCAL.model,
    };
  }

  // Either local, or cloud-with-opt-in: honour the (possibly overridden) config.
  const provider = inf?.provider ?? LOCAL.provider;
  const endpoint = inf?.endpoint ?? LOCAL.endpoint;
  const model = inf?.model ?? LOCAL.model;
  return { client: factory(provider, endpoint, undefined, model), model };
}
```

**CRITICAL fail-closed nuance vs. the providers factory:** when you build a cloud client, `createClient`
runs `validateApiKey` (`factory.ts:86-149,216`) and THROWS if e.g. `ANTHROPIC_API_KEY` is unset
(`factory.ts:96-103`). Because the resolver returns the LOCAL default (`openai-compat` + localhost) when
cloud-inference is OFF, that branch calls `createClient("openai-compat","http://localhost:11434/v1",...)`,
which hits `factory.ts:128-140` — openai-compat with a non-deepseek endpoint requires NO key, so it never
throws. This is why fail-closed-to-local does NOT trigger a cloud key requirement. Do not call createClient
with the cloud provider on the disabled path.

---

## 2. Patterns to Follow

### EgressGuard gate (the ONLY check the resolver uses)
**Source:** `src/medical/egress.ts`, lines 25-48
```ts
  static fromConfig(config: BoberConfig): EgressGuard {
    const med = config.medical;
    return new EgressGuard(
      med?.egress?.cloudInference ?? false,
      med?.egress?.literatureRetrieval ?? false,
      med?.egress?.deviceConnection ?? false,
    );
  }

  isAllowed(axis: EgressAxis): boolean {
    switch (axis) {
      case "cloud-inference":
        return this.cloudInference;
      ...
```
**Rule:** Gate cloud use with `egress.isAllowed("cloud-inference")`. Do NOT add a new axis (contract nonGoals).
Constructor is `new EgressGuard(cloudInference, literatureRetrieval, deviceConnection=false)` — tests build
`new EgressGuard(false, true)` (cloud OFF, literature ON) and `new EgressGuard(true, true)` for cloud ON.

### createClient seam + signature
**Source:** `src/providers/factory.ts`, lines 172-178
```ts
export function createClient(
  provider?: string | null,
  endpoint?: string | null,
  providerConfig?: Record<string, unknown>,
  model?: string,
  role?: string,
): LLMClient {
```
**Rule:** The local default call is exactly `createClient("openai-compat", "http://localhost:11434/v1", undefined, "llama3")`
(matches `engine.ts:402`). Third arg is `providerConfig` (object | undefined), NOT an apiKey string — pass
`undefined`. For cloud, pass `(provider, endpoint, undefined, model)`.

### Hardcoded line being replaced
**Source:** `src/medical/engine.ts`, lines 396-417
```ts
    if (outcome.kind === "grounded" && !hasNumericAnswer) {
      // ── Grounded synthesis path ────────────────────────────────────
      const llmClient: LLMClient = this.deps?.llmClient ?? createClient("openai-compat", "http://localhost:11434/v1", undefined, "llama3");
      answer = await synthesizeGrounded(userPrompt, outcome, llmClient, footer);
    } else {
      ...
    }

    await auditLog.append({ tIso: now, event: answer.abstained ? "abstain" : "answer", rulesetVersion });
```
**Rule:** Replace line 402's resolution with `buildMedicalInferenceClient`, but KEEP `deps.llmClient` winning
for tests (every grounded test injects `llmClient: llmSpy`). Suggested:
```ts
      const { client: llmClient, model: synthModel } = this.deps?.llmClient
        ? { client: this.deps.llmClient, model: "llama3" }
        : buildMedicalInferenceClient(config, egress);
      const groundedResult = await synthesizeGrounded(userPrompt, outcome, llmClient, footer, synthModel);
      answer = groundedResult.answer;
      criticVerdict = groundedResult.verdict;
```
Note `egress` is already in scope at `engine.ts:384` (`const egress = this.deps?.egress ?? EgressGuard.fromConfig(config);`)
and `config` is the `run()` parameter — no signature changes (contract nonGoals: zero-arg ctor, unchanged run sig).

### MedicalSopDeps injection seam
**Source:** `src/medical/engine.ts`, lines 47-66 — `llmClient?: LLMClient` (line 54) and `egress?: EgressGuard` (line 59).
**Rule:** Do not add new deps. `deps.llmClient` still short-circuits the resolver (tests rely on it).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `createClient` | `src/providers/factory.ts:172` | `(provider?, endpoint?, providerConfig?, model?, role?): LLMClient` | The ONLY client-construction seam; the resolver MUST use it. |
| `validateApiKey` | `src/providers/factory.ts:86` | `(resolvedProvider, role?, apiKey?, endpoint?): void` | Throws for missing cloud keys; openai-compat+non-deepseek needs none (why local fallback is safe). |
| `EgressGuard.fromConfig` | `src/medical/egress.ts:25` | `(config: BoberConfig): EgressGuard` | Builds the guard from config.medical.egress; engine already calls it at :384. |
| `EgressGuard.isAllowed` | `src/medical/egress.ts:35` | `(axis: EgressAxis): boolean` | The cloud-inference gate the resolver checks. Reuse, no new axis. |
| `synthesizeGrounded` | `src/medical/retrieval/literature.ts:259` | `(query, outcome, llm, footer): Promise<MedicalAnswer>` | The Sprint-2 fail-closed gate; WIDEN its return (see §6). Do NOT change gate logic. |
| `getGroundingVerdict` | `src/medical/retrieval/grounding-critic.ts:170` | `({llm,model,question,answerBody,passages}): Promise<GroundingVerdict>` | Critic call inside the gate; already takes a `model` string param — thread synthModel down to it. |
| `AuditLog.append` | `src/medical/audit.ts:44` | `(entry: AuditEntry): Promise<void>` | Append-only 0600 jsonl writer. criticVerdict rides inside the existing AuditEntry — no signature change. |
| `createDefaultConfig` | `src/config/schema.ts` (imported in engine.test.ts:19) | `(name, mode): BoberConfig` | Build a base config in tests; set `.medical.inference` / `.medical.egress` on the result. |

Utilities reviewed: `src/medical/` (egress, audit, types, inference target), `src/providers/` (factory), config schema. No `utils/`/`lib/`/`helpers/` module is involved in this sprint; the relevant shared helpers are the seven above.

---

## 4. Prior Sprint Output

### Sprint 1: src/medical/retrieval/grounding-critic.ts (commit 10bb964)
**Created:** `getGroundingVerdict` (grounding-critic.ts:170) + `GroundingVerdict` type (grounding-critic.ts:32: `{verdict:'approve'|'reject', feedback:string}`), `GROUNDING_MAX_LLM_CALLS` (grounding-critic.ts:9). Fail-closed: returns `{verdict:'reject'}` on parse exhaustion (grounding-critic.ts:205).
**Connection:** It already accepts a `model` string param (grounding-critic.ts:172). When you thread `synthModel`
into `synthesizeGrounded`, pass it through to BOTH `getGroundingVerdict` calls (literature.ts:284, :308) and
the `llm.chat` synthesis calls so the critic and the synthesizer use the same configured model.

### Sprint 2: src/medical/retrieval/literature.ts synthesizeGrounded + engine wiring (commit 90c3ca3)
**Created/wired:** `synthesizeGrounded` (literature.ts:259) wired into `engine.ts:403`; the local `llmClient`
is still constructed at `engine.ts:402`; `auditLog.append` at `engine.ts:417` has NO criticVerdict yet.
**Connection:** This sprint replaces the :402 client construction with the resolver, widens
`synthesizeGrounded`'s return so the engine can classify criticVerdict, and adds the field at :417.
Do NOT change the gate logic or the one-re-synthesis bound (`GROUNDED_GATE_MAX_LLM_CALLS`, literature.ts:187).

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` consulted for this briefing scope. The governing invariants live in code/contract:
ADR-6 zero-egress-by-default (egress.ts:1,4) and the "IDs/enums only — never prompt text or health values"
PHI rule (types.ts:64,75; audit.ts:15-18).

### Architecture Decisions
- ADR-6 (zero-egress, three independent axes default false): `src/medical/egress.ts:1,4,21`.
- Client-construction single seam: `src/providers/factory.ts:172` `createClient`; the resolver is the ONLY
  place that decides local-vs-cloud (contract assumptions).

### Other Docs
- ESLint medical boundary: `eslint.config.js:71-95` forbids `undici/got/axios/node-fetch/http/https/net/fetch`
  imports inside `src/medical/**` EXCEPT `medline-source.ts`/`whoop-client.ts` (eslint.config.js:101-103).
  `inference.ts` imports ONLY `createClient` from `../providers/factory.js` (a non-network import, already used
  at engine.ts:36) and types — so it passes the boundary. Do NOT add any network import to `inference.ts`.

---

## 6. synthesizeGrounded Return-Widening + criticVerdict Mapping

`synthesizeGrounded` currently returns `Promise<MedicalAnswer>` (literature.ts:259-264). It must be WIDENED to
also surface a three-way verdict so the engine can audit it WITHOUT changing gate behavior. Do NOT touch the
gate flow (synthesize → critic → one re-synth → abstain).

**New return type (suggested):**
```ts
export type CriticVerdict = "approve" | "reject-abstained" | "error-abstained";
export interface GroundedResult { answer: MedicalAnswer; verdict: CriticVerdict; }
```

**EXACT branch-point → enum mapping (current literature.ts line refs):**

| Current branch | Line | New verdict |
|----------------|------|-------------|
| First synthesis THROWS → `abstainAnswer` | 274-276 | `"error-abstained"` |
| synthesize abstained (empty/ABSTAIN/no-passages/model-unavailable) → `return answer` | 277 | `"error-abstained"` (model unavailable / no usable answer) — see note |
| First critique THROWS → `abstainAnswer` | 289-291 | `"error-abstained"` |
| First critique `approve` → `return answer` | 292 | `"approve"` |
| Re-synth THROWS → `abstainAnswer` | 298-300 | `"error-abstained"` |
| Re-synth abstained → `return answer2` | 301 | `"error-abstained"` |
| Re-critique THROWS → `abstainAnswer` | 313-315 | `"error-abstained"` |
| Re-critique `approve` → `answer2` | 316 | `"approve"` |
| Re-critique NOT approve → `abstainAnswer` (fail-closed after a reject) | 316 | `"reject-abstained"` |
| Non-grounded outcome → `synthesize(...)` (disabled/abstain) | 266-268 | `"error-abstained"` |

**Contract's intended three meanings (assumptions[5]):** `approve` = gate returned an approved answer;
`reject-abstained` = abstained AFTER a critic reject; `error-abstained` = abstained due to a thrown error.
The cleanest implementation: have the gate's local return paths carry the verdict. Returning `{answer, verdict}`
from each existing `return` keeps gate logic byte-identical — only the wrapper changes.

NOTE on line 277/266 ("synthesize abstained without ever reaching the critic"): there was no critic reject,
so it is NOT `reject-abstained`. Use `error-abstained` for these (no approval, no explicit reject) — this matches
the contract's binary "approve vs not-approved-by-critic" and "thrown/unavailable → error". Keep `reject-abstained`
EXCLUSIVELY for the path where the critic ran and did NOT approve after the re-synth (literature.ts:316 false branch)
and, if you choose, the post-first-reject path. Be consistent and assert it in tests (see §7 sc-3-6).

**Engine plumbing for the verdict:** add a `let criticVerdict: CriticVerdict | undefined;` before the
`if (outcome.kind === "grounded" ...)` block, set it from `groundedResult.verdict` on the grounded branch, leave
it `undefined` on the numeric/disabled/abstain branch, and pass it at the append:
```ts
await auditLog.append({
  tIso: now,
  event: answer.abstained ? "abstain" : "answer",
  rulesetVersion,
  ...(criticVerdict ? { criticVerdict } : {}),
});
```
(Spread-only-when-set keeps non-grounded entries identical to today.)

**Thread the model:** widen `synthesizeGrounded(query, outcome, llm, footer, model = "ollama/llama3")` and replace
the module-level `SYNTHESIS_MODEL` usages at the four call sites (literature.ts:137, :228, :285, :310) with the
passed `model`. Keep the `SYNTHESIS_MODEL` constant (literature.ts:47) as the DEFAULT so `synthesize` /
`synthesizeWithFeedback` keep working and the literature.test.ts cases (which call `synthesizeGrounded` with 4 args)
still compile via the default. Engine passes the resolver's `model` ("llama3" for the local default, or the cloud model).

---

## 7. AuditEntry Field Addition + Testing Patterns

### AuditEntry interface (types.ts:64-87) — exact addition
```ts
/** Discriminated audit event type. IDs/enums only — no prompt text or health values. */
export type AuditEvent = "consent" | "short-circuit" | "refuse" | "answer" | "abstain" | "ingest";

export interface AuditEntry {
  tIso: string;
  event: AuditEvent;
  rulesetVersion?: string;
  patternsetVersion?: string;
  ruleId?: string;
}
```
**ADD** (optional, additive, back-compatible — existing entries without it stay valid):
```ts
  /** Critic gate outcome on the grounded path. IDs/enums only — NEVER text. Sprint 3. */
  criticVerdict?: "approve" | "reject-abstained" | "error-abstained";
```
Keep the union literal IN types.ts so `CriticVerdict` (literature.ts) and the AuditEntry field stay in sync —
you may `import type { CriticVerdict }` from types.ts in literature.ts, or define it in types.ts and re-use.

### Unit Test Pattern — audit 0600 + PHI-free
**Source:** `src/medical/audit.test.ts:48-58` (mode) and `:105-125` (PHI-free)
```ts
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
// ...
const fileStat = await stat(join(tmpDir, ".bober", "medical", "audit-2026-06-16.jsonl"));
expect(fileStat.mode & 0o777).toBe(0o600);
// PHI-free:
expect(bytes).not.toContain("blood pressure"); // prompt text must not appear
expect(bytes).not.toContain("180");            // numeric health value must not appear
```
**Allowed-keys pattern (audit.test.ts:94):** when asserting IDs/enums-only, EXTEND the allow-set with the new key:
```ts
const allowed = new Set(["tIso","event","rulesetVersion","patternsetVersion","ruleId","criticVerdict"]);
```
**Runner:** vitest. **Assertion:** `expect`. **Mock:** `vi.fn()` / `vi.spyOn`. **File naming:** collocated `*.test.ts`. **Temp dirs:** `mkdtemp(join(tmpdir(), ...))` + `rm(..., {recursive:true,force:true})` in afterEach.

### Unit Test Pattern — grounded engine turn (criticVerdict + cloud gating)
**Source:** `src/medical/engine.test.ts:846-942`
```ts
const config = createDefaultConfig("test", "greenfield");
const { auditLog, gate, disclaimer } = await recordTestConsent(tmpDir2); // engine.test.ts:299
const egress = new EgressGuard(false, true); // cloud OFF, literature ON
const sourceStub = new MedlineSource(egress);
vi.spyOn(sourceStub, "fetchPassages").mockResolvedValue({ kind: "grounded", passages: [/* ... */] });
const literature = new LiteratureRetriever(egress, sourceStub);
const llmSpy: LLMClient = {
  chat: vi.fn()
    .mockResolvedValueOnce({ text: "<synth body>", toolCalls: [], stopReason: "end", usage: {inputTokens:100,outputTokens:50} })
    .mockResolvedValueOnce({ text: '{"verdict":"approve","feedback":""}', toolCalls: [], stopReason: "end", usage: {inputTokens:50,outputTokens:10} }),
};
const engine = new MedicalSopEngine({ auditLog, consentGate: gate, disclaimer, llmClient: llmSpy, egress, literature, facts, healthStore });
const result = await engine.run("what are the side effects of metformin?", tmpDir2, config, { now: "2026-06-16T12:00:00.000Z" });
// read & parse the jsonl:
const bytes = await readFile(join(tmpDir2, ".bober", "medical", "audit-2026-06-16.jsonl"), "utf-8");
const entries = bytes.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const answerEntry = entries.find((e) => e["event"] === "answer");
expect(answerEntry?.["criticVerdict"]).toBe("approve");
expect(egress.isAllowed("cloud-inference")).toBe(false);
```
Verdict-mapping cases to add:
- **approve:** synth + critic returns `{"verdict":"approve",...}` → audit `criticVerdict: "approve"`.
- **reject-abstained:** critic returns `{"verdict":"reject",...}` BOTH times (4 chat calls: synth, reject, re-synth, reject) → `event:"abstain"`, `criticVerdict:"reject-abstained"`.
- **error-abstained:** `llmSpy.chat` rejects/throws on the first call (`vi.fn().mockRejectedValue(new Error("down"))`) → `event:"abstain"`, `criticVerdict:"error-abstained"`.
For ALL three: assert the jsonl line has NO prompt substring (e.g. `not.toContain("metformin")` against the body, but note the rule id/version are allowed) and NO health value, and `stat(...).mode & 0o777 === 0o600`.

### Unit Test Pattern — inference.test.ts (cloud gating via factory spy)
Build `config` with `config.medical = { egress: { cloudInference: <bool>, ... }, inference: { provider: "anthropic", model: "claude-x" } }` and pass an INJECTED factory spy as the 3rd arg:
```ts
const spy = vi.fn((p?, e?, pc?, m?) => ({ chat: vi.fn() }) as unknown as LLMClient);
// sc-3-3 cloud OFF -> local fallback, spy NEVER called with a cloud provider:
const egressOff = new EgressGuard(false, false);
const { client, model } = buildMedicalInferenceClient(cfgWithCloudInference, egressOff, spy);
expect(model).toBe("llama3");
expect(spy).toHaveBeenCalledWith("openai-compat", "http://localhost:11434/v1", undefined, "llama3");
expect(spy).not.toHaveBeenCalledWith("anthropic", expect.anything(), expect.anything(), expect.anything());
// sc-3-4 cloud ON -> cloud client built:
const egressOn = new EgressGuard(true, false);
const r2 = buildMedicalInferenceClient(cfgWithCloudInference, egressOn, spy);
expect(spy).toHaveBeenCalledWith("anthropic", undefined /* or configured endpoint */, undefined, "claude-x");
expect(r2.model).toBe("claude-x");
// sc-3-5 no inference -> exact local default:
const r3 = buildMedicalInferenceClient(cfgNoInference, egressOff, spy);
expect(r3.model).toBe("llama3");
expect(spy).toHaveBeenCalledWith("openai-compat", "http://localhost:11434/v1", undefined, "llama3");
```
The injectable `factory` param (defaulting to real `createClient`) is the seam that lets the spy assert without
any network/key requirement. Without it, sc-3-4 would throw on the missing ANTHROPIC_API_KEY.

---

## 8. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/medical/egress.ts:26` | `config.medical` shape | low | Reads only `.egress`; new `.inference` sibling is additive — unaffected. |
| `src/medical/engine.ts:402,403,417` | hardcoded createClient + synthesizeGrounded return | medium | Replace :402 with resolver, widen :403 to read `.answer`/`.verdict`, add criticVerdict at :417. deps.llmClient must still win. |
| `src/medical/retrieval/literature.ts` callers | `synthesizeGrounded` return type | medium | Return widens from `MedicalAnswer` to `{answer,verdict}` — engine.ts:403 is the ONLY production caller; literature.test.ts calls it too (add a default `model` param so existing 4-arg calls still compile, and update test expectations to read `.answer` if they inspect the return). |
| `src/medical/types.ts` consumers | `AuditEntry` | low | Field is OPTIONAL & additive; all existing `auditLog.append({...})` calls remain valid. |

### Existing Tests That Must Still Pass
- `src/medical/audit.test.ts` — asserts 0600 + allowed-keys (`:94`) + PHI-free; the allowed-keys set must be EXTENDED with `criticVerdict` if any test there appends one; otherwise unchanged.
- `src/medical/engine.test.ts:846-942` — the grounded "answer" turn; currently asserts `chat` called 2× and audit `event:"answer"`. Still valid; you ADD a `criticVerdict:"approve"` assertion. All zero-LLM red-flag / refuse tests (engine.test.ts:947+) MUST stay green (resolver only runs on the grounded branch).
- `src/medical/retrieval/literature.test.ts` — synthesizeGrounded gate tests incl. "model unavailable (throws) => abstained" (`:214`). If they read the return as `MedicalAnswer`, update to `.answer`; the model param must default so 4-arg calls still compile.
- `src/medical/retrieval/grounding-critic.test.ts` — getGroundingVerdict unchanged (only the threaded model value differs).

### Features That Could Be Affected
- **Zero-egress invariant (ADR-6):** shares `egress.ts`. Verify a grounded turn with `cloudInference=false` builds ONLY the local client (resolver returns local). A network spy that throws on use must never fire.
- **Audit PHI rule:** shares `audit.ts`/`types.ts`. Verify criticVerdict is one of the three enum literals only — never free text, never a health number.

### Recommended Regression Checks (run after implementation)
1. `npm run build` — zero TS errors.
2. `npm run typecheck` — strict, zero errors (verifies the widened return + new field types).
3. `npm run test` — full suite (medical + fleet), zero failures; new `inference.test.ts` + updated engine/audit tests pass.
4. `npm run lint` — medical ESLint boundary (eslint.config.js:71-95) passes; no new network import in `inference.ts` or `engine.ts`.
5. Manual diff grep: confirm `inference.ts` imports ONLY `createClient` + types (no fetch/http/undici/axios).

---

## 9. Implementation Sequence

1. **src/config/schema.ts** — add the optional `inference:{provider?,endpoint?,model?}` block as a sibling of `egress` inside `MedicalSectionSchema` (lines 376-388). Leave egress untouched.
   - Verify: `npm run typecheck` clean; `config.medical?.inference` is typed `{provider?,endpoint?,model?}|undefined`.
2. **src/medical/types.ts** — add optional `criticVerdict?: "approve"|"reject-abstained"|"error-abstained"` to `AuditEntry` (after :86) with the "IDs/enums only — never text" doc comment. Optionally export a `CriticVerdict` alias.
   - Verify: `AuditEntry` still satisfies existing `auditLog.append` calls (all fields optional but `tIso`/`event`).
3. **src/medical/inference.ts** (new) — export `buildMedicalInferenceClient(config, egress, factory=createClient)` per §1 template, with the injectable factory seam. Import type-only `BoberConfig`, `LLMClient`, `EgressGuard`; runtime import `createClient`.
   - Verify: depends only on types + schema (step 1) + createClient; no network import.
4. **src/medical/retrieval/literature.ts** — widen `synthesizeGrounded` return to `{answer,verdict}`, add a `model` param (default `SYNTHESIS_MODEL`/"ollama/llama3"), thread `model` into the 4 chat/critic call sites, map each return branch to the verdict per §6 table. Do NOT change gate flow or the call budget.
   - Verify: literature.test.ts still compiles (4-arg calls use the default model); gate tests green.
5. **src/medical/engine.ts** — replace :402 client construction with the resolver (deps.llmClient still wins), thread `synthModel` into `synthesizeGrounded`, capture `criticVerdict`, add it to the `auditLog.append` at :417 (spread-only-when-set).
   - Verify: existing grounded test (engine.test.ts:846) passes; red-flag/refuse zero-LLM tests untouched.
6. **src/medical/inference.test.ts** (new) — sc-3-3/4/5 cases via the factory spy (cloud-off→local, cloud-on→cloud, no-config→exact local).
   - Verify: spy NEVER called with a cloud provider when cloudInference=false.
7. **src/medical/engine.test.ts + audit additions** — grounded approve / reject→reject / throw turns; read jsonl, assert the criticVerdict enum, PHI-free, 0600.
   - Verify: exactly one criticVerdict per grounded entry; no prompt/answer/health substring.
8. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run test`, `npm run lint`.

---

## 10. Pitfalls & Warnings

- **Fail-closed must use the LOCAL provider, never the cloud one.** Calling `createClient("anthropic",...)` when
  cloud-inference is off would throw on the missing API key (factory.ts:96-103). The disabled path MUST call
  `createClient("openai-compat","http://localhost:11434/v1",undefined,"llama3")` which requires NO key (factory.ts:128-140).
- **deps.llmClient must keep winning in the engine** — every grounded test injects `llmClient: llmSpy`. If the resolver
  runs unconditionally, the spy is bypassed and 20+ tests break. Gate it: `this.deps?.llmClient ? {...} : buildMedicalInferenceClient(...)`.
- **Do NOT add a network import to `inference.ts`.** eslint.config.js:71-95 will fail `npm run lint` for any
  `fetch/http/https/net/undici/axios/got/node-fetch` import under `src/medical/**`. The only sanctioned files are
  `medline-source.ts`/`whoop-client.ts` (eslint.config.js:101). `createClient` from `../providers/factory.js` is allowed (already used at engine.ts:36).
- **criticVerdict is an ENUM, never text.** No prompt, no answer body, no health number. Spread it only on the
  grounded path so numeric/disabled/abstain entries stay byte-identical to Sprint 2 (back-compat).
- **Do not change the gate logic or the one-re-synthesis bound** (contract nonGoals). Widening the return type is
  additive; the `synthesize → critic → re-synth → abstain` flow and `GROUNDED_GATE_MAX_LLM_CALLS` (literature.ts:187) stay as-is.
- **`config.medical.inference` has no `.default()`** (unlike egress's booleans). Absence resolves to the LOCAL default
  at runtime in the resolver — keep parsing tolerant; do not force-default in the schema.
- **`synthesizeGrounded` is called by literature.test.ts with 4 args** — add the `model` param with a DEFAULT so those
  calls keep compiling; only the engine passes the 5th arg.
- **Local-detection rule:** "local" = provider `openai-compat` AND endpoint contains `localhost`. A user who points
  `inference.endpoint` at a non-localhost openai-compat server is treated as CLOUD and gated (correct — that is egress).
