# Sprint Briefing: Personalization profile.yaml (SOPS-encrypted, injectable cipher) + profile CLI

**Contract:** sprint-spec-20260628-medical-ingest-5
**Generated:** 2026-06-28T00:00:00Z

---

## 0. TL;DR for the Generator

Build **`src/medical/profile.ts`** (new): a Zod `ProfileSchema`, a `ProfileCipher` seam interface, a default sops-via-execa cipher, and `writeProfile`/`readProfile(vaultDir, { cipher })` that REFUSE (throw, write no plaintext) when `cipher.available()` is false. Then add the `medical profile show|set` nested subtree to **`src/cli/commands/medical.ts`** by mirroring the Sprint-4 `suppCmd` pattern. Write **`src/medical/profile.test.ts`** with an injected reversible fake cipher + temp dir.

Three load-bearing findings up front:
1. **lab-note.ts YAML helpers are NOT reusable** for the profile — they are flat-scalar only (no array support) and the serializer is private. You must hand-roll a tiny YAML emit/parse that also handles `string[]` arrays. NO new dependency (no `yaml` pkg is vendored), and NEVER import `src/vault/*` (medical-module rule — lab-note.ts:9-12, supplements.ts:5).
2. **ProfileCipher seam shape** = a deps object `{ cipher }` with a default (mirrors `SupplementAddDeps`/`ImportLabsDeps` + the `inference.ts` default-param factory). Interface: `{ available(): boolean; encrypt(s): string|Promise<string>; decrypt(s): string|Promise<string> }`.
3. **execa probe + stdin pattern is established**: probe a binary with `execa(bin, ["--version"], { reject: false, timeout: 5000 })` → `result.exitCode === 0` (catch ENOENT → false); pass plaintext to a child via the `input:` option and read `result.stdout` back; treat `result.exitCode !== 0` as failure.

---

## 1. Target Files

### `src/medical/profile.ts` (create)

**Directory pattern:** Files in `src/medical/` are kebab/lowercase `.ts`, collocated `*.test.ts`, top-of-file block comment, `// -- Section --` unicode headers. See `src/medical/supplements.ts:1-12` and `src/medical/lab-note.ts:1-19`.

**Most similar existing files:**
- `src/medical/supplements.ts` — the full "pure module + injectable deps + run* cores" shape (Sprint 4). Closest structural template.
- `src/medical/inference.ts` — the injectable default-param seam (`factory: ClientFactory = createClient`, line 34).
- `src/medical/lab-note.ts` — hand-rolled YAML serialize/parse (flat-scalar, NOT array-capable — see §3).

**Structure template (skeleton — fill in):**
```ts
/**
 * Personalization profile -> SOPS-encrypted <vaultDir>/profile.yaml (Sprint 5).
 * Encryption is behind an injectable cipher seam; tests inject a reversible fake.
 * When the cipher is unavailable BOTH paths refuse and write NO plaintext PHI.
 * Hand-rolled flat YAML emit/parse (string[] arrays) — NEVER import src/vault.
 */
import { writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { ensureDir } from "../utils/fs.js";

// -- Schema --------------------------------------------------------------
export const ProfileSchema = z.object({
  age: z.number().int().min(0),
  sex: z.enum(["male", "female", "other"]),
  conditions: z.array(z.string()).default([]),
  medications: z.array(z.string()).default([]),
  supplements: z.array(z.string()).default([]),
  allergies: z.array(z.string()).default([]),
  goals: z.array(z.string()).default([]),
});
export type Profile = z.infer<typeof ProfileSchema>;

// -- Cipher seam ---------------------------------------------------------
export interface ProfileCipher {
  available(): boolean;
  encrypt(plaintext: string): string | Promise<string>;
  decrypt(ciphertext: string): string | Promise<string>;
}
// default = sops via execa (see §2 execa pattern). available() probes the binary.

// -- YAML emit/parse (flat scalars + string[] arrays) --------------------
// emitProfileYaml(p): string ; parseProfileYaml(raw): unknown (then ProfileSchema.parse)

// -- read / write --------------------------------------------------------
export interface ProfileDeps { cipher?: ProfileCipher }
export async function writeProfile(vaultDir: string, profile: Profile, deps?: ProfileDeps): Promise<void> { /* ... */ }
export async function readProfile(vaultDir: string, deps?: ProfileDeps): Promise<Profile> { /* ... */ }

// -- CLI cores -----------------------------------------------------------
export async function runProfileShow(projectRoot: string, opts: { vault?: string }, deps?: ProfileDeps): Promise<void> { /* ... */ }
export async function runProfileSet(projectRoot: string, key: string, value: string, opts: { vault?: string }, deps?: ProfileDeps): Promise<void> { /* ... */ }
```

---

### `src/cli/commands/medical.ts` (modify)

**What to change:** add a new `// -- medical profile --` block at the END of `registerMedicalCommand` (after the `suppCmd` block, currently ends at line 319) and add an import for the new profile cores at the top (alongside line 26).

**Mirror this exact nested-subtree shape (lines 293-319) — the Sprint-4 `suppCmd` pattern:**
```ts
// ── medical supplements ───────────────────────────────────────────────
const suppCmd = medicalCmd
  .command("supplements")
  .description("Manage supplements list in FactStore (scope: medical)");

suppCmd
  .command("add <name>")
  .description("...")
  .option("--dose <d>", "...")
  .action(async (name: string, opts: { dose?: string }) => {
    const projectRoot = await resolveRoot();
    await runSupplementAdd(projectRoot, name, opts);
  });

suppCmd
  .command("list")
  .description("...")
  .option("--file <path>", "...")
  .action(async (opts: { file?: string }) => {
    const projectRoot = await resolveRoot();
    await runSupplementList(projectRoot, opts);
  });
```
Your version becomes `const profileCmd = medicalCmd.command("profile")` with `profileCmd.command("show")` and `profileCmd.command("set <key> <value>")`, each `.action` calling `resolveRoot()` then the extracted core. Production `.action` passes NO deps (the default sops cipher is used).

**Import line to add (mirror line 26):**
```ts
import { runProfileShow, runProfileSet } from "../../medical/profile.js";
```

**`.action` error contract — NEVER throw; set `process.exitCode` and return.** The core functions own the try/catch (mirror `runSupplementAdd` at supplements.ts:181-188 and the inline `medical import` handler at medical.ts:256-264):
```ts
} catch (err) {
  process.stderr.write(
    chalk.red(`Failed to ...: ${err instanceof Error ? err.message : String(err)}\n`),
  );
  process.exitCode = 1;   // CLI handlers MUST NOT throw (facts.ts:135-142, medical.ts:262-263)
}
```

**Imports this file uses (relevant):** `chalk` (medical.ts:6), `Command` type (medical.ts:7 — `import type`), `resolveRoot()` helper (medical.ts:30-33), run* cores from sibling modules (medical.ts:25-26).

**Imported by:**
- `src/cli/index.ts:40` (`import { registerMedicalCommand }`), wired at `src/cli/index.ts:320`.
- `src/cli/commands/medical.test.ts:471` and `src/medical/ingestion.test.ts:201,236` (registration smoke tests — MUST still pass).

**Test file:** `src/cli/commands/medical.test.ts` exists. Your new `profile.ts` cores get their OWN test file: `src/medical/profile.test.ts` (does not exist).

---

## 2. Patterns to Follow

### Pattern A — Injectable seam with a real default (the ProfileCipher precedent)
**Source:** `src/medical/inference.ts`, lines 16-17 and 31-35
```ts
/** Injectable factory seam so tests can spy without real network. Defaults to the real createClient. */
export type ClientFactory = typeof createClient;

export function buildMedicalInferenceClient(
  config: BoberConfig,
  egress: EgressGuard,
  factory: ClientFactory = createClient,   // <- default real impl, override in tests
): { client: LLMClient; model: string } {
```
**Rule:** Expose `ProfileCipher` as an interface; the default `writeProfile`/`readProfile` use the real sops cipher when `deps.cipher` is undefined; tests pass a reversible fake. (Contract specifies the `{ cipher }` deps-object form — combine with Pattern B.)

### Pattern B — Injectable deps object + extracted core (the run* shape)
**Source:** `src/medical/supplements.ts`, lines 125-189 (`SupplementAddDeps`, `runSupplementAdd`)
```ts
export interface SupplementAddDeps {
  store?: FactStore;
  now?: string;
}
export async function runSupplementAdd(
  projectRoot: string, name: string, opts: { dose?: string },
  deps: SupplementAddDeps = {},
): Promise<void> {
  let ownedStore: FactStore | undefined;        // own-vs-injected resource tracking
  try {
    let store: FactStore;
    if (deps.store !== undefined) store = deps.store;
    else { /* construct the real one */ ownedStore = new FactStore(...); store = ownedStore; }
    /* ... */
  } catch (err) {
    process.stderr.write(`Failed to add supplement: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    ownedStore?.close();
  }
}
```
**Rule:** `runProfileShow`/`runProfileSet` take a trailing `deps: ProfileDeps = {}`; production `.action` passes nothing. Errors are caught, written to stderr, `process.exitCode = 1`; never re-thrown.

### Pattern C — execa binary probe (the cipher.available() precedent)
**Source:** `src/graph/prereq.ts:13-22` and `src/providers/claude-code.ts:48-55`
```ts
const defaultBinaryProbe: BinaryProbe = async (binary) => {
  try {
    const r = await execa(binary, ["--version"], { reject: false, timeout: 5_000 });
    return r.exitCode === 0;
  } catch {
    return false; // ENOENT -> not on PATH
  }
};
```
**Rule:** `available()` probes the `sops` binary. Note the contract types `available(): boolean` (sync). Either (a) cache a probe result computed at construction, or (b) use a sync existence check (`which`/`execaSync`) — but the SIMPLEST contract-faithful approach is: the default cipher's `available()` returns the result of a sync `execaSync("sops", ["--version"], { reject:false })`-style probe wrapped in try/catch. Tests never hit this — the fake cipher overrides `available()`.

### Pattern D — execa: pass plaintext on stdin, read result on stdout, detect non-zero exit
**Source:** `src/providers/claude-code.ts:141-154`
```ts
const result = await execa(this.binary, args, {
  reject: false,
  timeout: this.timeoutMs,
  input: "",          // <- stdin is passed via the `input` option
});
if (result.exitCode !== 0) {
  throw new Error(`claude CLI exited ${String(result.exitCode)}: ${result.stderr || result.stdout || "no output"}`);
}
// use result.stdout
```
**Rule:** The default sops cipher's `encrypt(plaintext)` runs `execa("sops", ["-e", "--input-type","yaml","--output-type","yaml","/dev/stdin"], { input: plaintext, reject:false })` (or your chosen sops invocation with an age recipient), throwing on `exitCode !== 0`, returning `result.stdout`; `decrypt` mirrors with `-d`. The EXACT sops flags are not test-verified (fake cipher is injected) — keep the shell-out plausible and behind `available()`.

### Pattern E — Zod schema field idioms
**Source:** `src/fleet/manifest.ts:2,10,16` + `src/contracts/spec.ts:115,139,147`
```ts
import { z } from "zod";
tier: z.enum(["default", "cheap", "standard", "hard", "frontier"]).optional(),  // manifest.ts:10
concurrency: z.number().int().min(1).default(3),                                // manifest.ts:16
dependencies: z.array(z.string()).default([]),                                  // spec.ts:115
ambiguityScore: z.number().int().min(0).max(10).optional(),                     // spec.ts:147
```
**Rule:** `age: z.number().int().min(0)`, `sex: z.enum(["male","female","other"])`, the five lists `z.array(z.string()).default([])`. Import `{ z } from "zod"` (NOT a namespace import). zod is `^3.24.2`.

### Pattern F — `runProfileSet` field update via Zod
For `set <key> <value>`: read current profile (or a default), set one field, then re-validate. `value` arrives as a string from commander, so coerce per-key (e.g. `key === "age"` -> `Number(value)`; list keys -> push/replace a string). Validate with `ProfileSchema.parse(next)` so a bad `sex` or negative `age` throws a Zod error caught by the core's try/catch (sc-5-4 path also exercised at the CLI boundary).

---

## 3. lab-note.ts YAML helpers — REUSABLE? (explicit verdict)

**Verdict: NOT reusable. Hand-roll a small dedicated YAML emit/parse for the profile.**

Evidence:
- `serializeLabFrontmatter` (`src/medical/lab-note.ts:95-109`) is **not exported** and emits **flat scalars only** (`key: value` lines). No array syntax.
- `parseLabNote` (`src/medical/lab-note.ts:120-179`, exported) parses **flat scalars only**, coercing numbers via `NUM_REGEX` (line 86); it has no list handling and returns the fixed `LabNoteFrontmatter` shape — unusable for a profile with five `string[]` fields.
- `parseSupplementsFile` (`src/medical/supplements.ts:42-93`) DOES parse a single `supplements:` list with `  - item` lines, but it is hard-wired to one key and the `name | dose` pipe format — not a general flat+array emitter.

**Therefore:** emit YAML like below (the profile is small + flat; scalars `age`/`sex` plus five string arrays). Mirror the lab-note fence/loop *style* (lab-note.ts:96-108 for emit, lab-note.ts:121-148 for the fence-find + `colonIdx` split) but ADD list support:
```
age: 42
sex: male
conditions:
  - hypertension
medications: []
supplements:
  - vitamin d
allergies: []
goals:
  - lower ldl
```
Keep it minimal: numbers unquoted, strings unquoted (the schema's `.parse` is the validation gate), empty arrays as `key: []` or a `key:` with no children. Parsing reuses the supplements list-detection idea (`/^\s+-\s+(.+)$/` at supplements.ts:72). **NO new dependency. NEVER import `src/vault/frontmatter.ts` or `src/vault/profile.ts`** (the medical module rule, lab-note.ts:9-12).

> Note: a separate `src/vault/profile.ts` exists and only DETECTS a SOPS top-level `sops:` key (no crypto) — it is a different module. Do not import it; you may borrow the idea that an encrypted file carries a top-level `sops:` mapping when writing the sc-5-3 "or is encrypted" assertion.

---

## 4. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `ensureDir` | `src/utils/fs.ts` (imported lab-note.ts:18, medical.ts:9) | `(dir: string): Promise<void>` | Recursively mkdir before writing the profile.yaml |
| `findProjectRoot` | `src/utils/fs.ts` (imported medical.ts:9) | `(): Promise<string \| undefined>` | Used by `resolveRoot()`; the CLI boundary already resolves root |
| `resolveRoot` | `src/cli/commands/medical.ts:30-33` | `(): Promise<string>` | Reuse in the new `.action`s — do NOT re-derive the root |
| `slugify` | `src/medical/lab-note.ts:58-63` | `(s: string): string` | URL-safe slug (not needed for a single profile.yaml; listed to prevent re-creating) |
| `z` (zod) | `zod` pkg `^3.24.2` (manifest.ts:2) | `import { z } from "zod"` | Schema + `.parse()` validation — do not hand-roll validation (principles.md:29) |
| `execa` | `execa` pkg `^9.5.2` (claude-code.ts:34) | `execa(bin, args, opts)` | sops shell-out + binary probe — already a dependency, do not add a child-process wrapper |
| `chalk` | `chalk` (medical.ts:6) | `chalk.red(...)` / `chalk.green(...)` | stderr/stdout coloring in `.action` error paths |

Directories reviewed: `src/utils/` (fs.ts, git.ts, logger.ts), `src/state/` (facts.ts), `src/medical/` — the above are the applicable ones. No existing cipher/encryption util and no YAML library exist (confirmed: `grep "sops" src/` returns only the unrelated `src/vault/profile.ts` detector; no `yaml` dependency vendored).

---

## 5. Prior Sprint Output

### Sprint 2 (181f30c): `src/medical/lab-note.ts`
**Exports:** `slugify`, `deriveLabStatus`, `parseLabNote`, `writeLabNote`, types `LabStatus`/`LabNoteMeta`/`LabNoteFrontmatter`. Private: `serializeLabFrontmatter`.
**Connection:** Reference for hand-rolled flat-scalar YAML emit/parse STYLE (fence loop, colon split). Do NOT import it; it cannot serialize arrays (see §3).

### Sprint 3 (cd4a2ea): `src/cli/commands/medical.ts` — `runImportLabs`
**Exports:** `runImportLabs`, `ImportLabsDeps`. Established the "extracted core + injected deps + nested subcommand" pattern and the `.action` error contract (medical.ts:204-213).
**Connection:** Your `runProfileShow/Set` follow this exact extraction shape.

### Sprint 4 (90842ec): `src/medical/supplements.ts` + `suppCmd` subtree
**Exports:** `runSupplementAdd`, `runSupplementList`, `SupplementAddDeps`, `parseSupplementsFile`, `supplementToFact`, `DEFAULT_DOSE`. Registered the nested `supplements` subtree under `medicalCmd` (medical.ts:293-319).
**Connection:** MIRROR `suppCmd` to build `profileCmd` with `show` + `set <key> <value>`. Your test mirrors `supplements.test.ts` (temp dir + injected deps + stdout spy).

---

## 6. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM + `.js` import extensions** for NodeNext (principles.md:27). Every relative import ends in `.js`.
- **Zod for validation, `z.parse()`** — no hand-rolled validation (principles.md:29). ProfileSchema is the gate.
- **`import type { ... }`** — `consistent-type-imports` enforced (principles.md:35). Import the commander `Command` and any type-only symbols with `import type`.
- **No synchronous fs** — `node:fs/promises` only (principles.md:42). (Caveat: if `available()` must be sync, prefer a cached async probe result over `fs.*Sync`; sops `execaSync` for a binary probe is acceptable since it is a process probe, not an fs op — but a cached async probe is cleaner.)
- **No `any`** — use `unknown` + narrowing (principles.md:40). Parse YAML to `unknown`, then `ProfileSchema.parse`.
- **`// -- Section --`** unicode headers (principles.md:32); collocated `*.test.ts` (principles.md:20).
- **`_`-prefix** unused params (principles.md:36).

### Architecture Decisions
No sprint-specific ADR file was loaded for this sprint. Contract assumptions cite research-20260627 section 3b (only the structured `profile.yaml` is SOPS-encrypted; markdown bodies stay plaintext-in-private-repo) and section 4a (profile holds age/sex/conditions/medications/supplements/allergies/goals; goals feed downstream analysis). The egress/PHI posture from prior medical sprints applies: audit logs record IDs/enums only, never PHI (medical.ts:112, 198) — but this sprint adds NO audit entry requirement.

### Other Docs
`CLAUDE.md` global rule: medical module is zero-egress by default; this sprint's only outbound process is the local `sops` shell-out (no network).

---

## 7. Testing Patterns

### Unit Test Pattern (the primary template)
**Source:** `src/medical/supplements.test.ts` (temp dir + injected deps + stdout spy) and `src/medical/inference.test.ts` (injected fake seam)
```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-profile-"));
  process.exitCode = 0;
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
```

**Reversible fake cipher (sc-5-2 round-trip) — inject this, NEVER call real sops:**
```ts
function fakeCipher(available = true): ProfileCipher {
  return {
    available: () => available,
    // base64 = reversible, proves write encrypts and read decrypts the same bytes
    encrypt: (s) => "SOPS:" + Buffer.from(s, "utf-8").toString("base64"),
    decrypt: (s) => Buffer.from(s.replace(/^SOPS:/, ""), "base64").toString("utf-8"),
  };
}
```
- **sc-5-2:** `await writeProfile(tmpDir, profile, { cipher: fakeCipher() })` then `const back = await readProfile(tmpDir, { cipher: fakeCipher() })` → `expect(back.age).toBe(...)`, `expect(back.sex).toBe(...)`, `expect(back.goals).toEqual(...)`. Optionally assert the on-disk `profile.yaml` does NOT contain the plaintext (it's base64/SOPS-wrapped).
- **sc-5-3 (safety):** with `fakeCipher(false)`, `await expect(writeProfile(tmpDir, profile, { cipher: fakeCipher(false) })).rejects.toThrow()` AND assert no readable plaintext profile exists: e.g. `await expect(readFile(join(tmpDir, "profile.yaml"), "utf-8")).rejects` (file absent) — or if your design pre-creates then guards, assert the file content has no plaintext PHI / carries the encrypted marker. Also `await expect(readProfile(tmpDir, { cipher: fakeCipher(false) })).rejects.toThrow()`.
- **sc-5-4 (Zod):** `expect(() => ProfileSchema.parse({ ...valid, age: -1 })).toThrow();` and `expect(() => ProfileSchema.parse({ ...valid, sex: "unknown" })).toThrow();`

**Zod-rejection assertion precedent:** `src/config/schema.test.ts:116,120` (`expect(() => HistorySectionSchema.parse({ maxActiveLines: 0 })).toThrow()`). `.safeParse(...).success === false` (schema.test.ts:83) is the alternative — `.toThrow()` matches the contract wording "raise a Zod validation error" most directly.

**stdout capture (for runProfileShow):** `src/medical/supplements.test.ts:205-210`
```ts
const writes: string[] = [];
const spy = vi.spyOn(process.stdout, "write").mockImplementation((c) => { writes.push(String(c)); return true; });
await runProfileShow(tmpDir, { vault: tmpDir }, { cipher: fakeCipher() });
spy.mockRestore();
expect(writes.join("")).toContain("age");
```

**CLI registration smoke (optional, if you assert the subtree wires):** `src/cli/commands/medical.test.ts:470-477`
```ts
const program = new Command();
program.exitOverride();
registerMedicalCommand(program);
await program.parseAsync(["node", "bober", "medical", "profile", "show"]);
```

**Runner:** vitest. **Assertion:** `expect`. **Mock:** `vi.fn` / `vi.spyOn` + injected deps (NO module-level fs mocks — principles.md:44). **Naming:** `profile.test.ts` collocated next to `profile.ts`.

### E2E Test Pattern
Not applicable — this is a CLI/library sprint; no Playwright config governs `src/medical/`.

---

## 8. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/cli/index.ts:40,320` | `registerMedicalCommand` (medical.ts) | low | Additive subcommand only; existing `import` + wiring unchanged. Build must stay green. |
| `src/cli/commands/medical.test.ts:471` | `registerMedicalCommand` | low | Registration smoke test; adding a subtree must not throw at registration time. |
| `src/medical/ingestion.test.ts:201,236` | `registerMedicalCommand` | low | Same registration smoke; verify still callable. |
| `src/medical/profile.test.ts` (new) | `src/medical/profile.ts` | n/a | New, owns its own coverage. |

### Existing Tests That Must Still Pass
- `src/cli/commands/medical.test.ts` — exercises `registerMedicalCommand` + the whoop/import-labs actions; your additive `profileCmd` block must not disturb existing subcommands.
- `src/medical/ingestion.test.ts:181-239` — asserts `registerMedicalCommand` is callable and sets exitCode on bad input.
- `src/medical/supplements.test.ts`, `src/medical/inference.test.ts`, `src/medical/lab-note.test.ts` — unchanged source; should be untouched but confirm no shared-symbol regression.

### Features That Could Be Affected
- **`medical supplements` / `medical import-labs` / `medical whoop sync`** — share the `medicalCmd` root and `resolveRoot()`. Verify all four subtrees still register and run after adding `profile`. The `profile` lists are a denormalized snapshot; FactStore stays canonical for structured meds/supplements (contract assumption — no FactStore writes from this sprint).

### Recommended Regression Checks
1. `npm run build` exits 0 (sc-5-1; compiles `src/medical/profile.ts` + extended CLI, strict mode).
2. `npx vitest run src/medical/profile.test.ts` — all profile tests green (sc-5-2/3/4).
3. `npx vitest run src/medical/ src/cli/commands/medical.test.ts` — medical + CLI registration suites still pass.
4. `npx eslint src/medical/profile.ts src/cli/commands/medical.ts` — zero errors (`consistent-type-imports`, no unused, no `any`).
5. Confirm NO real `sops` process is spawned during tests (grep the test for `execa`/`sops` — should be absent; the fake cipher is injected).

---

## 9. Implementation Sequence

1. **`src/medical/profile.ts` — `ProfileSchema` (Zod) + `Profile` type.**
   - Verify: `expect(() => ProfileSchema.parse({ age:-1, sex:"male" })).toThrow()` and bad-sex both throw (sc-5-4). `z.array(z.string()).default([])` makes lists optional on input.
2. **`ProfileCipher` interface + default sops/execa impl + `available()` probe.**
   - Verify: `tsc` accepts the seam; default impl uses `execa` with `{ reject:false, timeout }` + `input:` stdin (Pattern D) and the binary probe (Pattern C). No test calls it.
3. **`emitProfileYaml` / `parseProfileYaml` (flat scalars + `string[]`).**
   - Verify: a unit round-trips an object through emit→parse→`ProfileSchema.parse` and recovers age/sex/goals. Borrow lab-note fence loop + supplements list regex.
4. **`writeProfile(vaultDir, profile, { cipher })` + `readProfile(vaultDir, { cipher })` with refuse-when-unavailable + no-plaintext guarantee.**
   - Verify (sc-5-2): write→read round-trips through `fakeCipher()`. Verify (sc-5-3): `fakeCipher(false)` → both reject AND no readable plaintext `profile.yaml` on disk. Write order: serialize → `cipher.encrypt` → `writeFile`; NEVER `writeFile` plaintext before encrypting, and bail BEFORE any write when `!cipher.available()`.
5. **`runProfileShow` / `runProfileSet` cores** (deps object, try/catch, `process.exitCode=1`, never throw).
   - Verify: stdout spy shows rendered profile; `set` re-validates via `ProfileSchema.parse` and on a bad value sets exitCode=1.
6. **Register `profile show|set` subtree in `src/cli/commands/medical.ts`** (mirror `suppCmd`, add the import).
   - Verify: `registerMedicalCommand(new Command())` registers without throwing; `parseAsync([...,"medical","profile","show"])` resolves.
7. **`src/medical/profile.test.ts`** — sc-5-2 round-trip, sc-5-3 refuse+no-plaintext, sc-5-4 Zod rejects.
   - Verify: vitest green.
8. **Run full verification** — `npm run build`; `npx vitest run src/medical/ src/cli/commands/medical.test.ts`; `npx eslint src/medical/profile.ts src/cli/commands/medical.ts`.

---

## 10. Pitfalls & Warnings

- **lab-note YAML helpers are flat-scalar only — DO NOT reuse for arrays.** `serializeLabFrontmatter` is private and array-blind; `parseLabNote` returns the fixed lab shape. Hand-roll the profile emitter (see §3).
- **NEVER import `src/vault/*`** (incl. the unrelated `src/vault/profile.ts` SOPS-detector). Medical module rule: lab-note.ts:9-12, supplements.ts:5.
- **No-plaintext guarantee ordering:** check `cipher.available()` and bail BEFORE serializing/writing anything; in `writeProfile`, the ONLY thing that touches disk is the already-encrypted ciphertext. If you ever need a temp write, use the encrypted bytes only. The sc-5-3 evaluator will assert no plaintext PHI is readable.
- **`available()` is typed `boolean` (sync) in the contract** — don't make it return a Promise. For the default sops cipher, compute the probe synchronously (e.g. a guarded `execaSync` binary probe) or cache an eagerly-computed boolean. Tests override it entirely, so keep the real impl simple and never let it throw.
- **commander passes everything as strings** — in `set <key> <value>`, coerce `age` to a number before `ProfileSchema.parse`, else `z.number()` rejects a string `"42"`.
- **`.action` MUST NOT throw** — production callers pass no deps; the default sops cipher's `available()===false` (no sops installed) must surface as a clean stderr message + exitCode 1, NOT an unhandled rejection (medical.ts:262-263, supplements.ts:181-186).
- **ESM `.js` extensions + `import type`** on every relative import / type-only symbol (principles.md:27,35) or the build/lint gate fails.
- **No new dependency** — there is no vendored `yaml` package; adding one violates the contract. Use the hand-rolled emitter + `execa`/`zod` (both already deps: execa ^9.5.2, zod ^3.24.2).
- **Don't add an audit entry or FactStore write** — out of scope; the profile lists are a denormalized snapshot only (contract assumption 4).
