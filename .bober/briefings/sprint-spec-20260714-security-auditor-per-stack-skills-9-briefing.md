# Sprint Briefing: Labelled vulnerable/safe benchmark corpus + measurement harness

**Contract:** sprint-spec-20260714-security-auditor-per-stack-skills-9
**Generated:** 2026-07-14T00:00:00Z

> Deliver architecture success criterion #3: make detection quality **measured, not asserted**. Author a small labelled corpus (>=12 vulnerable + >=12 safe, grounded in shipped skill signatures) and a **pure/deterministic** harness that runs finder-only vs finder+verifier over the corpus and shows the verifier lowers the safe-set false-positive-block rate while retaining vulnerable-set recall — driven by injected fakes so CI needs no LLM/network.

---

## 0. TL;DR — the four files and the one trap that will sink this sprint

- `benchmark/harness.ts` — a **pure** `measure(corpus, finderFn, verifierFn)` returning `{finderOnly, finderPlusVerifier}` metrics. No fs, no network, **no `Math.random`, no `new Date()`** (evaluatorNotes hard rule).
- `benchmark/harness.test.ts` — three tests: (1) corpus counts sc-9-1, (2) fake-driven FP-reduction+retained-recall sc-9-3, (3) label-grounding sc-9-4. Loads the manifest via `import manifest from "./fixtures/manifest.json" with { type: "json" }`.
- `benchmark/fixtures/manifest.json` — the labelled corpus. **Inline the code snippets as string fields** — do NOT emit `.ts`/`.js` fixture files (they would be linted/compiled; see Pitfall #1).
- `benchmark/fixtures/README.md` — documents the corpus + the optional real-provider run.

**THE TRAP (read Pitfall #1 and #2 first):** intentionally-vulnerable code as `.ts` files under `src/` **fails `eslint src/` and `tsc`**. And the supply-chain class has **no shipped skill signature** — the label-grounding test will fail if the supply-chain fixture declares a `signatureId`.

---

## 1. Target Files

### src/orchestrator/security-knowledge/benchmark/harness.ts (create)

**Directory pattern:** siblings in `src/orchestrator/security-knowledge/` are single-purpose modules, kebab-if-multiword filenames, `.js` import extensions, a top doc-comment citing the ADR/sprint, then types, then the export. See `supply-chain-inspector.ts:1-25` (doc comment + `export interface ... Input` + `export async function inspect...`) and `signature.ts:27-50` (interface-only module).

**Most similar existing file for the pure-function shape:** `src/orchestrator/security-knowledge/supply-chain-inspector.ts` — a pure fold over data returning typed records, never throws. The harness is even simpler (synchronous, no fs).

**Structure template (dependency order: types -> pure helpers -> `measure`):**
```ts
import type { VulnClass } from "../../security-audit-types.js";
import type { SecurityStackId } from "../signature.js";

/** One labelled benchmark case (mirrors a manifest.json entry). */
export interface BenchmarkCase {
  /** Stable id, unique in the corpus (used by fakes to pick the FP subset). */
  id: string;
  expected: "vulnerable" | "safe";
  stack: SecurityStackId;
  /** Only meaningful for expected:"vulnerable". Omitted for scanner-only classes (supply-chain). */
  signatureId?: string;
  vulnClass?: VulnClass;
  /** The illustrative snippet — inline, never a separate compiled file. */
  code: string;
}

/** Injected finder: does this case get flagged CRITICAL? (pluggable so CI uses a fake). */
export type FinderFn = (c: BenchmarkCase) => boolean;

/**
 * Injected verifier: given the finder's critical verdict, the post-verify verdict.
 * DOWNGRADE-ONLY, mirroring VerifierResult semantics (security-verifier-agent.ts:29-39):
 * may only turn true->false (drop/downgrade), never false->true.
 */
export type VerifierFn = (c: BenchmarkCase, finderCritical: boolean) => boolean;

export interface StageMetrics {
  /** vulnerable cases flagged critical / total vulnerable cases (detection retained). */
  recall: number;
  /** safe cases flagged critical / total safe cases (false-positive BLOCK rate — lower is better). */
  fpBlockRate: number;
}

export interface MeasureResult {
  finderOnly: StageMetrics;
  finderPlusVerifier: StageMetrics;
}

/** PURE. No fs, no network, NO Math.random, NO new Date(). */
export function measure(corpus: BenchmarkCase[], finderFn: FinderFn, verifierFn: VerifierFn): MeasureResult {
  const vulnerable = corpus.filter((c) => c.expected === "vulnerable");
  const safe = corpus.filter((c) => c.expected === "safe");

  const finderOnly = (c: BenchmarkCase) => finderFn(c);
  const finderPlusVerifier = (c: BenchmarkCase) => verifierFn(c, finderFn(c));

  const rate = (cases: BenchmarkCase[], flag: (c: BenchmarkCase) => boolean) =>
    cases.length === 0 ? 0 : cases.filter(flag).length / cases.length;

  return {
    finderOnly: { recall: rate(vulnerable, finderOnly), fpBlockRate: rate(safe, finderOnly) },
    finderPlusVerifier: { recall: rate(vulnerable, finderPlusVerifier), fpBlockRate: rate(safe, finderPlusVerifier) },
  };
}
```
Note: `recall` here counts vulnerable cases flagged critical (higher is better); `fpBlockRate` counts safe cases flagged critical (i.e. cases the gate would BLOCK — lower is better). Both are defined exactly as sc-9-2 states.

**Imports this file needs:** `VulnClass` from `../../security-audit-types.js` (verify the depth: `benchmark/` is one level under `security-knowledge/`, so `security-audit-types.ts` is `../../`); `SecurityStackId` from `../signature.js`.

**Imported by:** `harness.test.ts` only (this is a leaf measurement module — no production wiring; nonGoals: "Do not gate the pipeline on benchmark thresholds").

**Test file:** `benchmark/harness.test.ts` (create).

---

### src/orchestrator/security-knowledge/benchmark/fixtures/manifest.json (create)

**Format:** a JSON array of `BenchmarkCase` objects. Snippets go **inline** in the `code` string field (see Pitfall #1). Precedent for data-as-committed-JSON imported into a test: `src/orchestrator/workflow/__fixtures__/lens-vectors.json` consumed by `reconcile-conformance.test.ts:6`.

**Shape of each entry** (draw `code` verbatim from the skill `Unsafe:`/`Safe:` blocks cited in section 4):
```json
[
  {
    "id": "vuln-igaming-toctou",
    "expected": "vulnerable",
    "stack": "igaming",
    "signatureId": "igaming.toctou-balance-double-spend",
    "vulnClass": "race-condition",
    "code": "const account = await db.query(\"SELECT balance FROM accounts WHERE id = $1\", [id]);\nif (account.balance >= amount) {\n  await db.query(\"UPDATE accounts SET balance = balance - $1 WHERE id = $2\", [amount, id]);\n}"
  },
  {
    "id": "safe-igaming-toctou",
    "expected": "safe",
    "stack": "igaming",
    "code": "const result = await db.query(\"UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance\", [amount, id]);\nif (result.rowCount === 0) throw new Error(\"insufficient balance\");"
  }
]
```
- `expected:"vulnerable"` entries MUST carry a `signatureId`+`vulnClass` that grounds (section 4) — EXCEPT the supply-chain case (Pitfall #2).
- `expected:"safe"` entries carry NO `signatureId`/`vulnClass` (the grounding test only iterates vulnerable cases; keeping safe labels bare avoids confusion).
- `stack` values must be verbatim `SecurityStackId` members: `igaming | dex-backend | node | ...` (`signature.ts:10-18`).

---

### src/orchestrator/security-knowledge/benchmark/fixtures/README.md (create)

Documents: the corpus purpose (grounded regression guard + few-shot exemplars per contract assumptions[3]), the label schema, the offline CI path (injected fakes), and the OPTIONAL local real-provider run (section 6 / Pitfall #5). Markdown only — not compiled, not linted.

---

## 2. Patterns to Follow

### Pattern A — Pure conformance test over committed JSON vectors
**Source:** `src/orchestrator/workflow/reconcile-conformance.test.ts:1-24`
```ts
import { describe, it, expect } from "vitest";
import vectors from "./__fixtures__/lens-vectors.json" with { type: "json" };

describe("reconcile twin/port conformance (ADR-4 drift gate)", () => {
  for (const vector of vectors as LensVector[]) {
    it(`twin and port agree for "${vector.name}"`, () => {
      const tsOut = tsReconcile("s", 1, vector.lensVerdicts, TS);
      expect(jsOut).toEqual(tsOut);
    });
  }
});
```
**Rule:** import the corpus with the `with { type: "json" }` attribute (repo-proven, suite green), cast to your typed array, iterate. This is the exact template for `harness.test.ts` loading `manifest.json`. `resolveJsonModule: true` is already set (`tsconfig.json:13`).

### Pattern B — Deterministic sentinel instead of `new Date()`
**Source:** `src/orchestrator/workflow/reconcile-conformance.test.ts:8`
```ts
const TS = "2026-01-01T00:00:00.000Z"; // sentinel timestamp (matches reconciler.test.ts:6)
```
**Rule:** the harness and its tests use fixed literals; never `new Date()` / `Date.now()` / `Math.random()` (evaluatorNotes: "make sure the harness itself is deterministic").

### Pattern C — Load the SecurityKnowledgeIndex against the real repo skills root
**Source:** `src/orchestrator/security-knowledge/index.test.ts:10-11,28-32`
```ts
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REPO_SKILLS_ROOT = join(REPO_ROOT, "skills");
// ...
const index = new SecurityKnowledgeIndex(REPO_SKILLS_ROOT);
await index.load();
for (const stackId of ALL_STACK_IDS) {
  const signatures = index.forStack(stackId);
}
```
**Rule:** for the label-grounding test, construct `new SecurityKnowledgeIndex(REPO_SKILLS_ROOT)` with the explicit root and `await index.load()` before reading. From `benchmark/harness.test.ts` the root is FOUR `..` up (`benchmark/` -> `security-knowledge/` -> `orchestrator/` -> `src/` -> repo root), then `skills`. Do NOT reuse `getSecurityKnowledgeIndex()` — it is a **private, non-exported** helper in `security-auditor-agent.ts:40`.

### Pattern D — Injectable function-type seam for CI determinism
**Source:** `src/orchestrator/security-verifier-agent.ts:52-55`
```ts
/** Injectable seam so `runSecurityAudit` tests can stub the stage (mirrors `SecurityDiffProvider`). */
export interface SecurityVerifier {
  verify(params: VerifyParams): Promise<VerifierResult>;
}
```
**Rule:** the repo already models "real component behind an injectable function type so tests stub it." Your `FinderFn`/`VerifierFn` are the harness equivalents — the required test injects fakes; the real `runSecurityAudit`/`runSecurityVerifier` satisfy the same shape for the optional local run (assumptions[1]).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `SecurityKnowledgeIndex` | `src/orchestrator/security-knowledge/index.ts:35` | `new (skillsRoot?)`, `load(): Promise<void>`, `forStack(id): SecuritySignature[]`, `all(): SecuritySignature[]` | Parses & memoises all 8 shipped skill files' signatures. Use `all()` for the grounding test's signatureId set. |
| `SecuritySignature` (type) | `src/orchestrator/security-knowledge/signature.ts:27-50` | `{ signatureId, vulnClass, stackId, severity, ... }` | Shape of each parsed signature. `signatureId` + `vulnClass` are the fields the corpus grounds against. |
| `SecurityStackId` (type) | `src/orchestrator/security-knowledge/signature.ts:10-18` | union of 8 stack ids | Type the manifest's `stack` field with this (verbatim members). |
| `VulnClass` (type) | `src/orchestrator/security-audit-types.ts:9-26` | 17-member union incl. `"supply-chain"`, `"idor-bola"`, `"race-condition"`, `"money-integrity"` | Type the manifest's `vulnClass` field. Note the exact spellings (Pitfall #3). |
| `ALL_VULN_CLASSES` | `src/orchestrator/stack-knowledge.ts:19` | `VulnClass[]` (all 17) | Runtime array of every valid VulnClass. Use to validate the supply-chain case's `vulnClass` when there is no signatureId to ground against. |
| `VerifierResult` (type) | `src/orchestrator/security-verifier-agent.ts:30-39` | `{ verified, downgraded, dropped, ran }` | The real verifier's downgrade-only contract your `VerifierFn` fake models (true->false only). |
| `SecuritySignatureParser.parse` | `src/orchestrator/security-knowledge/parser.ts:137-155` | `(stackId, markdown, relPath) => SecuritySignature[]` | The producer behind the index; you should NOT call it directly — go through the index. |

Utilities reviewed: there is **no** existing benchmark/metrics/recall utility anywhere under `src/` — `measure` is genuinely new. There is no `utils/` recall or corpus helper to reuse (searched; none applicable).

---

## 4. Grounded fixture pairs — DRAW `code` VERBATIM FROM THESE

Every pair below is a real shipped signature. Use the **Unsafe** block as the `expected:"vulnerable"` fixture's `code` and the **Safe** block as the paired `expected:"safe"` fixture's `code`. This is what "grounded" means (contract assumptions[3]) and is what sc-9-4 cross-checks. **12 grounded vulnerable + 12 grounded safe below**, plus the supply-chain pair in section 5 = 13/13, clearing the >=12/>=12 bar.

| # | signatureId | vulnClass | stack | class covered | Skill source (Unsafe / Safe) |
|---|-------------|-----------|-------|---------------|------------------------------|
| 1 | `igaming.toctou-balance-double-spend` | `race-condition` | `igaming` | TOCTOU | `skills/bober.security-igaming/SKILL.md:47-52 / 55-61` |
| 2 | `igaming.client-supplied-odds` | `money-integrity` | `igaming` | client-odds | `skills/bober.security-igaming/SKILL.md:94-96 / 99-102` |
| 3 | `igaming.negative-zero-stake` | `money-integrity` | `igaming` | money-integrity | `skills/bober.security-igaming/SKILL.md:113-115 / 118-121` |
| 4 | `dex.withdrawal-toctou-race` | `race-condition` | `dex-backend` | withdrawal race | `skills/bober.security-dex-backend/SKILL.md:49-52 / 55-61` |
| 5 | `dex.token-decimals-mismatch` | `money-integrity` | `dex-backend` | decimals | `skills/bober.security-dex-backend/SKILL.md:144-146 / 149-152` |
| 6 | `dex.hot-wallet-key-in-env` | `secret-handling` | `dex-backend` | hot-wallet key | `skills/bober.security-dex-backend/SKILL.md:183-185 / 188-190` |
| 7 | `dex.unvalidated-withdrawal-amount` | `money-integrity` | `dex-backend` | money-integrity | `skills/bober.security-dex-backend/SKILL.md:296-298 / 301-306` |
| 8 | `node.sql-injection` | `injection` | `node` | SQLi | `skills/bober.security-node/SKILL.md:47-49 / 52-54` |
| 9 | `node.command-injection` | `injection` | `node` | command | `skills/bober.security-node/SKILL.md:83-85 / 88-90` |
| 10 | `node.ssrf-outbound-fetch` | `ssrf` | `node` | SSRF | `skills/bober.security-node/SKILL.md:122-124 / 127-130` |
| 11 | `node.bola-missing-ownership` | `idor-bola` | `node` | BOLA / access-control | `skills/bober.security-node/SKILL.md:141-143 / 146-151` |
| 12 | `node.jwt-alg-none` | `authn-authz` | `node` | auth | `skills/bober.security-node/SKILL.md:259-261 / 264-267` |

**Verbatim snippet examples (copy exactly, escape newlines/quotes for JSON):**

`igaming.client-supplied-odds` (money-integrity, client-odds) — `skills/bober.security-igaming/SKILL.md:93-102`:
```ts
// UNSAFE
const payout = req.body.stake * req.body.odds; // client controls the multiplier directly
// SAFE
const currentOdds = await priceService.getOdds(req.body.selectionId); // server-resolved at acceptance
const payout = req.body.stake * currentOdds;
```

`dex.token-decimals-mismatch` (money-integrity, decimals) — `skills/bober.security-dex-backend/SKILL.md:143-152`:
```ts
// UNSAFE
const humanAmount = Number(rawAmount) / 1e18; // wrong for USDC (6) and WBTC (8)
// SAFE
const decimals = await tokenContract.decimals();
const humanAmount = ethers.formatUnits(rawAmount, decimals);
```

`dex.hot-wallet-key-in-env` (secret-handling) — `skills/bober.security-dex-backend/SKILL.md:182-190`:
```ts
// UNSAFE
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY); // key material in plaintext env
// SAFE
const signer = new KmsSigner(process.env.KMS_KEY_ID); // key never leaves the KMS/HSM boundary
```

`node.sql-injection` (injection) — `skills/bober.security-node/SKILL.md:46-54`:
```ts
// UNSAFE
const rows = await db.query(`SELECT * FROM users WHERE id = ${req.query.id}`);
// SAFE
const rows = await db.query("SELECT * FROM users WHERE id = $1", [req.query.id]);
```

`node.command-injection` (injection) — `skills/bober.security-node/SKILL.md:82-90`:
```ts
// UNSAFE
exec(`convert ${req.body.file} out.png`);
// SAFE
execFile("convert", [req.body.file, "out.png"]);
```

`node.ssrf-outbound-fetch` (ssrf) — `skills/bober.security-node/SKILL.md:121-130`:
```ts
// UNSAFE
const res = await fetch(req.body.url);
// SAFE
assertAllowedOutboundHost(req.body.url); // rejects RFC1918 / 169.254.169.254 / non-allowlisted
const res = await fetch(req.body.url);
```

`node.bola-missing-ownership` (idor-bola) — `skills/bober.security-node/SKILL.md:140-151`:
```ts
// UNSAFE
const doc = await db.query("SELECT * FROM documents WHERE id = $1", [req.params.id]);
// SAFE
const doc = await db.query("SELECT * FROM documents WHERE id = $1 AND owner_id = $2", [req.params.id, req.session.userId]);
```

(#1/#4 TOCTOU pairs are already quoted verbatim in section 1's manifest example.)

---

## 5. Supply-chain class — the ONE fixture that does NOT ground on a signatureId

**Critical structural fact:** searched every `skills/bober.security-*/SKILL.md` — **no skill signature has `vulnClass: supply-chain`** (verified: `grep '**VulnClass:** supply-chain' skills/` returns nothing; vulnClass tally across all skills has no supply-chain row). The supply-chain axis is **scanner-emitted, not skill-authored**: `src/orchestrator/security-knowledge/supply-chain-inspector.ts:93-100` builds findings with `vulnClass: "supply-chain"`, `source: "supply-chain-inspector"`, and **NO `signatureId`**.

Consequence for the corpus:
- The malicious-postinstall fixture MUST set `vulnClass: "supply-chain"` and **OMIT `signatureId`** (there is nothing in the index to ground it against — declaring one WILL fail sc-9-4).
- The grounding test therefore has two arms (Pitfall #2 / section 7).

**Recommended supply-chain pair** (illustrative snippet — inline, drawn from the inspector's own `checkLifecycleScripts` heuristic at `supply-chain-inspector.ts:104-122`, so it doubles as a regression exemplar for that check):
```json
{
  "id": "vuln-supplychain-postinstall",
  "expected": "vulnerable",
  "stack": "node",
  "vulnClass": "supply-chain",
  "code": "\"scripts\": { \"postinstall\": \"node -e \\\"eval(Buffer.from(process.env.X,'base64').toString())\\\"\" }"
}
```
Paired safe fixture (`expected:"safe"`, no labels): a plain `"scripts": { "build": "tsc" }` line, or a lockfile `"resolved": "https://registry.npmjs.org/..."` entry. The safe supply-chain case does NOT need grounding.

This yields **13 vulnerable + 13 safe** total across all six required class buckets (iGaming money-integrity TOCTOU+client-odds; dex-backend withdrawal-race+decimals+hot-wallet-key; injection SQLi+command+SSRF; supply-chain postinstall; access-control BOLA).

---

## 6. Testing Patterns

### Unit test skeleton (harness.test.ts)
**Runner:** vitest. **Assertion:** `expect`. **Mocks:** none needed — the fakes ARE the test doubles (no `vi.mock`). **File naming:** co-located `harness.test.ts`. **Location:** co-located (matches `index.test.ts`, `supply-chain-inspector.test.ts`).

```ts
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { measure, type BenchmarkCase, type FinderFn, type VerifierFn } from "./harness.js";
import { SecurityKnowledgeIndex } from "../index.js";
import { ALL_VULN_CLASSES } from "../../stack-knowledge.js";
import manifest from "./fixtures/manifest.json" with { type: "json" };

const corpus = manifest as BenchmarkCase[];

// A fixed FP subset: safe cases the finder over-flags (deterministic — hardcoded ids, no random).
const FALSE_POSITIVE_SAFE_IDS = new Set(["safe-node-ssrf", "safe-igaming-toctou"]);

// finderFake: critical iff the case is vulnerable OR in the fixed FP subset.
const finderFake: FinderFn = (c) => c.expected === "vulnerable" || FALSE_POSITIVE_SAFE_IDS.has(c.id);
// verifierFake: DOWNGRADE-ONLY. Disproves the safe FP subset (true->false), confirms vulnerable.
const verifierFake: VerifierFn = (c, finderCritical) => {
  if (!finderCritical) return false;                 // never promote (mirrors VerifierResult)
  if (c.expected === "safe" && FALSE_POSITIVE_SAFE_IDS.has(c.id)) return false; // disproved
  return true;                                       // confirmed
};

describe("security benchmark corpus (sc-9-1)", () => {
  it("has >= 12 vulnerable and >= 12 safe cases across the required classes", () => {
    expect(corpus.filter((c) => c.expected === "vulnerable").length).toBeGreaterThanOrEqual(12);
    expect(corpus.filter((c) => c.expected === "safe").length).toBeGreaterThanOrEqual(12);
  });
});

describe("measure: verifier reduces FP-block while retaining recall (sc-9-2/sc-9-3)", () => {
  it("finder+verifier has strictly lower fpBlockRate and equal-or-higher recall", () => {
    const { finderOnly, finderPlusVerifier } = measure(corpus, finderFake, verifierFake);
    expect(finderPlusVerifier.fpBlockRate).toBeLessThan(finderOnly.fpBlockRate); // strict
    expect(finderPlusVerifier.recall).toBeGreaterThanOrEqual(finderOnly.recall); // retained
  });
});

describe("every vulnerable label is grounded in a shipped signature (sc-9-4)", () => {
  it("cross-checks signatureId/vulnClass against the parsed index", async () => {
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
    const index = new SecurityKnowledgeIndex(join(repoRoot, "skills"));
    await index.load();
    const byId = new Map(index.all().map((s) => [s.signatureId, s]));

    for (const c of corpus.filter((c) => c.expected === "vulnerable")) {
      if (c.signatureId) {
        const sig = byId.get(c.signatureId);
        expect(sig, `signatureId ${c.signatureId} not found in index`).toBeDefined();
        expect(sig!.vulnClass).toBe(c.vulnClass); // label consistency
      } else {
        // scanner-only class (supply-chain): ground on the VulnClass union instead.
        expect(ALL_VULN_CLASSES).toContain(c.vulnClass);
      }
    }
  });
});
```

With this corpus + fakes the numbers are: `finderOnly = { recall: 1, fpBlockRate: 2/13 }`, `finderPlusVerifier = { recall: 1, fpBlockRate: 0 }` — `0 < 2/13` (strict) and `1 >= 1` (retained). Deterministic, no LLM, no network.

### Optional local real-provider run (sc-9-5, non-CI)
**Rule:** gate any real wiring behind `describe.skip(...)` or an env flag so CI never calls a provider. The real `runSecurityAudit` (`security-auditor-agent.ts:81`) and `runSecurityVerifier` (`security-verifier-agent.ts:59`) satisfy the finder/verifier roles; adapt them into `FinderFn`/`VerifierFn` closures. Document the exact command in `fixtures/README.md`. Do NOT leave it un-skipped.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends on | Risk | What to check |
|------|-----------|------|---------------|
| (none) | — | **low** | This sprint is **purely additive** — four brand-new files in a new `benchmark/` dir. `grep -rn "benchmark/harness"` returns no existing importers. No production module imports the harness (nonGoals: not a gate). |

The harness reads `SecurityKnowledgeIndex`/`VulnClass`/`SecurityStackId` but does not modify them, so no existing consumer changes.

### Existing Tests That Must Still Pass
- `src/orchestrator/security-knowledge/index.test.ts` — asserts each of the 8 stacks parses `>= 6` signatures. Your grounding test reuses this exact loading pattern; if it passes, your grounding test's index is valid.
- `src/orchestrator/security-knowledge/skill-files.test.ts` — the real-asset table test that asserts **zero dropped blocks** and specific `signatureId`s exist (e.g. `solidity.reentrancy-single-function`). This is the canonical proof that the `signatureId`s you cite in the manifest are real. If you invent a signatureId not in the skills, THIS test won't catch it but YOUR sc-9-4 test will fail — cross-check against section 4's table.
- `src/orchestrator/security-knowledge/supply-chain-inspector.test.ts` — governs the supply-chain finding shape (no signatureId). Confirms the section-5 decision.
- `src/orchestrator/security-verifier-agent.test.ts` — governs `VerifierResult` downgrade-only semantics your fake models.

### Features That Could Be Affected
- **Sprint 8 finder+verifier pipeline** — shares the conceptual model your fakes emulate. No code shared; verify only that your `VerifierFn` fake stays downgrade-only (true->false), matching `VerifierResult` (`security-verifier-agent.ts:29-39`).
- **Sprint 10 (dogfood + docs)** — out of scope here (contract `outOfScope`), but it will consume this harness; keep `measure`'s exported types clean.

### Recommended Regression Checks (run after implementation)
1. `npm run build` (`tsc`) — must emit clean; watch the `with { type: "json" }` import compiles (it already does for `reconcile-conformance.test.ts`, but that file is `.test.ts` and thus tsc-excluded — keep the manifest import in the **test** file, not `harness.ts`, so tsc never sees the attribute).
2. `npx tsc --noEmit` (`npm run typecheck`).
3. `npm run lint` (`eslint src/`) — must pass; this is where inline-snippet (not `.ts` fixtures) matters (Pitfall #1).
4. `npm test -- security-knowledge/benchmark` then the full `npm test` suite green (sc-9-5).

---

## 8. Implementation Sequence

1. **`benchmark/harness.ts`** — types (`BenchmarkCase`, `FinderFn`, `VerifierFn`, `StageMetrics`, `MeasureResult`) then the pure `measure`. No fs/Date/random.
   - Verify: `npx tsc --noEmit` clean; `measure` has zero imports beyond the two `type` imports.
2. **`benchmark/fixtures/manifest.json`** — 13 vulnerable + 13 safe entries. 12 vulnerable grounded via section 4's table (verbatim `code`), plus the supply-chain case (section 5, no signatureId). Safe entries bare (no labels).
   - Verify: valid JSON (`node -e "JSON.parse(require('fs').readFileSync('.../manifest.json'))"`); every vulnerable `signatureId` appears in section 4's table.
3. **`benchmark/harness.test.ts`** — the three describes from section 6 (counts / FP-reduction / grounding). Fakes hardcode the FP-subset ids (deterministic).
   - Verify: `npm test -- benchmark` green; the sc-9-3 strict inequality holds; sc-9-4 iterates only vulnerable cases and uses the two-arm ground (signatureId-in-index OR vulnClass-in-ALL_VULN_CLASSES).
4. **`benchmark/fixtures/README.md`** — corpus doc + label schema + the env-gated real-provider command.
   - Verify: markdown only; not picked up by tsc/eslint.
5. **Full verification** — `npm run build` && `npx tsc --noEmit` && `npm run lint` && `npm test` (sc-9-5).

---

## 9. Pitfalls & Warnings

- **PITFALL #1 — Do NOT create `.ts`/`.js` fixture snippet files.** `eslint src/` lints `src/**/*.ts` and `src/**/*.js` (`eslint.config.js:6`), and `tsc` compiles `src/**/*` (`tsconfig.json` include). Intentionally-vulnerable code (SQLi template literals, `eval`, unused vars, bare `fetch`) will FAIL lint/typecheck and break sc-9-5. **Inline every snippet as a `code` string in `manifest.json`** (JSON is data, not compiled/linted). The estimatedFiles list confirms this: only `manifest.json` + `README.md`, no snippet files. If separate files are ever truly needed, give them a non-`.ts`/`.js` extension (e.g. `.fixture`) so both tools ignore them.
- **PITFALL #2 — The supply-chain fixture cannot declare a `signatureId`.** No shipped skill has `vulnClass: supply-chain` (section 5). If you set a `signatureId` on it, sc-9-4 fails (`index.all()` has no such id). Omit `signatureId`; set `vulnClass: "supply-chain"`; ground it via `ALL_VULN_CLASSES.includes(vulnClass)` in the else-arm. This is why the grounding test has two arms.
- **PITFALL #3 — VulnClass spellings are exact union members.** Use `idor-bola` (NOT `bola`/`access-control`), `race-condition` (NOT `toctou`/`race`), `money-integrity`, `secret-handling`, `authn-authz` (NOT `auth`), `ssrf`, `injection`, `supply-chain`. Full list: `security-audit-types.ts:9-26`. A wrong spelling breaks either the TS type (if typed) or the grounding assertion. `access-control` was already caught as a non-existent VulnClass in `skill-files.test.ts`'s doc comment — do not reintroduce it.
- **PITFALL #4 — Keep the manifest import in the TEST file, and `harness.ts` pure.** `tsc` excludes `**/*.test.ts` (`tsconfig.json` exclude), so the `with { type: "json" }` attribute and the fs-free style live safely in `harness.test.ts`. If you import the manifest inside `harness.ts` (a compiled file), you add a compile-time dependency on the import-attribute and couple the pure function to a specific corpus. `measure` must take `corpus` as a parameter.
- **PITFALL #5 — No `Math.random`/`new Date()`/`Date.now()` anywhere in the harness or its fakes.** evaluatorNotes explicitly checks this. The FP subset is a hardcoded `Set` of ids, not a sampled one. There is no repo-wide lint rule enforcing this (the `no-restricted-globals` rules at `eslint.config.js:65,94` are scoped to telemetry/ and medical/ only) — it is an evaluator/reviewer gate, so self-enforce.
- **PITFALL #6 — `getSecurityKnowledgeIndex()` is private.** It is a module-local function in `security-auditor-agent.ts:40`, not exported. Construct `new SecurityKnowledgeIndex(REPO_SKILLS_ROOT)` directly (Pattern C). From `benchmark/harness.test.ts` the repo root is FOUR `..` up (not three, as in `index.test.ts` which sits one level higher).
- **PITFALL #7 — `fpBlockRate` direction.** It is the fraction of SAFE cases flagged critical (cases the gate would wrongly block); LOWER is better and the sc-9-3 assertion is `finderPlusVerifier.fpBlockRate < finderOnly.fpBlockRate`. `recall` is the fraction of VULNERABLE cases flagged; HIGHER is better and the assertion is `>=`. Do not invert these.
