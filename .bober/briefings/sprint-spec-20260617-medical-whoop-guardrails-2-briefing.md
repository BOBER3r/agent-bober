# Sprint Briefing: WHOOP egress axis + authenticated transport

**Contract:** sprint-spec-20260617-medical-whoop-guardrails-2
**Generated:** 2026-06-17T00:00:00Z

> Scope: add a THIRD independent EgressAxis `"device-connection"` (default false), a
> `WhoopTokenStore` (env creds + 0600 sidecar, NO network), and a `WhoopClient`
> (the SECOND ESLint-excepted network file: OAuth refresh, v2 paginated fetch,
> 401-refresh-retry-once, 429-Reset-wait via an INJECTED waiter). No sync adapter,
> no CLI, no persistence beyond the token sidecar (those are Sprint 3).

---

## 1. Target Files

### src/medical/egress.ts (modify)

The FULL current file is 46 lines. Three additive edits; the existing two arms stay byte-identical.

**Current union (line 5):**
```typescript
export type EgressAxis = "cloud-inference" | "literature-retrieval";
```
=> becomes `"cloud-inference" | "literature-retrieval" | "device-connection"`.

**Current constructor (lines 17-21):**
```typescript
export class EgressGuard {
  constructor(
    private readonly cloudInference: boolean,
    private readonly literatureRetrieval: boolean,
  ) {}
```
=> add a third positional `private readonly deviceConnection: boolean,`.
WARNING: existing tests call `new EgressGuard(false, false)`, `new EgressGuard(false, true)`,
`new EgressGuard(true, false)`, `new EgressGuard(true, true)` (egress.test.ts:9,25,33,40,49 etc.).
A third REQUIRED positional param breaks ALL of those 2-arg calls at compile time.
The Generator MUST add the third egress.test.ts arg to those existing calls OR (cleaner)
keep the existing calls valid. The contract's evaluatorNotes say "existing egress tests
unchanged" — so the third constructor param should be OPTIONAL with a false default:
`private readonly deviceConnection: boolean = false,`. Confirm by re-reading the failing
2-arg call sites in egress.test.ts before deciding.

**Current fromConfig (lines 23-30):**
```typescript
static fromConfig(config: BoberConfig): EgressGuard {
  const med = config.medical;
  return new EgressGuard(
    med?.egress?.cloudInference ?? false,
    med?.egress?.literatureRetrieval ?? false,
  );
}
```
=> add `med?.egress?.deviceConnection ?? false,` as the third arg.

**Current isAllowed (lines 33-35) — A TERNARY, not a switch:**
```typescript
isAllowed(axis: EgressAxis): boolean {
  return axis === "cloud-inference" ? this.cloudInference : this.literatureRetrieval;
}
```
The contract/generatorNotes repeatedly demand an "exhaustive switch with a compile-time
never guard". This ternary has NO never guard and would silently mis-route a third axis
(`"device-connection"` would fall into the `: this.literatureRetrieval` branch — a BUG).
=> Rewrite as an exhaustive switch (see Pattern 1 below). `assertAllowed` (lines 41-45)
delegates to `isAllowed` and stays as-is — only `isAllowed` needs the switch.

**Imports this file uses:** `import type { BoberConfig } from "../config/schema.js";` (line 2)
**Imported by:** `src/medical/egress.test.ts`, `src/medical/retrieval/medline-source.ts:4`,
`src/medical/retrieval/literature.ts` (+.test), `src/medical/engine.ts` (+.test)
(grep below). Adding an OPTIONAL third param + switch is source-compatible with all of them.
**Test file:** `src/medical/egress.test.ts` (exists — 67 lines, sc-6-5 suite).

---

### src/medical/egress.test.ts (modify)

Add NEW describe blocks for three-axis flags, the independence matrix, and `fromConfig`
default-false for `device-connection`. Keep the existing sc-6-5 suite passing
(see the "third constructor param OPTIONAL" note above). Pattern is identical to the
existing tests at lines 7-67.

---

### src/config/schema.ts (modify)

**Current medical egress object (lines 376-387):**
```typescript
export const MedicalSectionSchema = z.object({
  /** Egress opt-in axes (ADR-6). Both default false — zero outbound bytes by default. */
  egress: z
    .object({
      /** When true, cloud inference synthesis is permitted. Default false. */
      cloudInference: z.boolean().default(false),
      /** When true, literature retrieval (MedlinePlus) is permitted. Default false. */
      literatureRetrieval: z.boolean().default(false),
    })
    .optional(),
});
```
=> add ONE sibling line after `literatureRetrieval`:
`deviceConnection: z.boolean().default(false),` with a doc comment. Nothing else changes.
`BoberConfig` is inferred (schema.ts:421) so `med?.egress?.deviceConnection` typechecks in egress.ts.

**Imported by:** egress.ts:2 imports `type BoberConfig` from here; loader.ts parses it.

---

### src/medical/whoop/whoop-token.ts (create) — NO NETWORK

**Directory:** `src/medical/whoop/` does NOT exist yet — create it. Naming is kebab-case
`.ts` collocated with `.test.ts` (matches `src/medical/retrieval/medline-source.ts`).
**Most similar existing files:** `src/medical/consent.ts` (JSON sidecar read/write at 0600)
+ `src/providers/factory.ts:94-103` (env-credential read + clear throw) + `src/medical/audit.ts`
(ensureDir + `.bober/medical` path under projectRoot).
**Exports:** `WhoopTokenStore` class.
**Interface (from arch doc lines 77-81):**
```typescript
interface WhoopTokenStore {
  clientCredentials(): { clientId: string; clientSecret: string };   // throws if env vars unset
  readRefreshToken(): Promise<string | undefined>;                   // undefined => not yet authorized
  writeTokens(tokens: { accessToken: string; refreshToken: string; expiresAtIso: string }): Promise<void>; // 0600
}
```
**Structure template (mirror consent.ts + factory.ts + audit.ts):**
```typescript
/** WhoopTokenStore — WHOOP OAuth creds (env) + 0600 refresh-token sidecar. NO network (ADR-2). */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureDir } from "../../utils/fs.js"; // NOTE: two levels up from src/medical/whoop/

// ── Types ────────────────────────────────────────────────────────────
export interface WhoopTokens {
  accessToken: string;
  refreshToken: string;
  expiresAtIso: string;
}

// ── WhoopTokenStore ──────────────────────────────────────────────────
export class WhoopTokenStore {
  constructor(private readonly projectRoot: string) {}

  private path(): string {
    return join(this.projectRoot, ".bober", "medical", "whoop-token.json");
  }

  /** Reads WHOOP_CLIENT_ID/WHOOP_CLIENT_SECRET from env; throws clearly if unset. */
  clientCredentials(): { clientId: string; clientSecret: string } {
    const clientId = process.env["WHOOP_CLIENT_ID"];
    const clientSecret = process.env["WHOOP_CLIENT_SECRET"];
    if (!clientId || !clientSecret) {
      throw new Error(
        "WHOOP credentials missing — set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET " +
          "environment variables and try again.",
      );
    }
    return { clientId, clientSecret };
  }

  /** Returns the stored refresh token, or undefined when the sidecar is absent/corrupt. */
  async readRefreshToken(): Promise<string | undefined> {
    try {
      const data = JSON.parse(await readFile(this.path(), "utf-8")) as Partial<WhoopTokens>;
      return typeof data.refreshToken === "string" ? data.refreshToken : undefined;
    } catch {
      return undefined; // absent or corrupt => not yet authorized (fail-closed read)
    }
  }

  /** Persist tokens at .bober/medical/whoop-token.json with mode 0600. */
  async writeTokens(tokens: WhoopTokens): Promise<void> {
    await ensureDir(join(this.projectRoot, ".bober", "medical"));
    await writeFile(this.path(), JSON.stringify(tokens, null, 2) + "\n", {
      encoding: "utf-8",
      mode: 0o600,
    });
  }
}
```
WARNING on the 0600 guarantee: `writeFile(..., { mode: 0o600 })` only sets mode when it
CREATES the file; if the file already exists it does NOT re-chmod. `consent.ts:77-81` uses
exactly this `writeFile` form and its test passes, so it is the sanctioned pattern. If the
test requires a guaranteed 0600 even on overwrite, use the audit.ts `open(path, O_WRONLY|
O_CREAT|O_TRUNC, 0o600)` + `fh.chmod(0o600)` form instead. Default to the consent.ts
`writeFile` form unless the mode test fails; do NOT use `appendFile` (audit.ts:43 warns it
ignores mode).

---

### src/medical/whoop/whoop-token.test.ts (create)

Mirror `src/medical/audit.test.ts` (mkdtemp temp dir + fs.stat mode assert) and the
`src/providers/factory.test.ts` save/delete/restore env-stub idiom (see Pattern 5 + 6).

---

### src/medical/whoop/whoop-client.ts (create) — THE SECOND ESLint NETWORK EXCEPTION

**Most similar existing file:** `src/medical/retrieval/medline-source.ts` (THE template —
FetchLike type, module-const base URL, `assertAllowed` BEFORE fetch, injectable `fetchImpl`).
**Exports:** `WhoopClient` class + the `WhoopCollection`/`SyncWindow`/`WhoopPage`/
`WhoopRecord`/`FetchLike` types.
**Exact type shapes (from arch doc lines 56-66 — use verbatim):**
```typescript
type WhoopCollection = "recovery" | "sleep" | "cycle" | "workout";
type SyncWindow = { startIso: string; endIso: string };
type WhoopPage = { records: WhoopRecord[]; nextCursor?: string }; // nextCursor undefined => last page
type WhoopRecord = { id: string; tStartIso: string; tEndIso?: string; metrics: Record<string, number> };
// NOTE: WHOOP FetchLike EXTENDS the medline one — adds `init` arg + `headers.get()` (needed for 429 Reset + POST refresh):
type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;
```
**Module constants (mirror MEDLINEPLUS_BASE at medline-source.ts:46):**
```typescript
const WHOOP_API_BASE = "https://api.prod.whoop.com";
const WHOOP_TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token"; // OAuth2 token endpoint
const COLLECTION_PATHS: Record<WhoopCollection, string> = {
  recovery: "/v2/recovery",
  sleep: "/v2/activity/sleep",
  cycle: "/v2/cycle",
  workout: "/v2/activity/workout",
};
```
**Constructor + injected waiter (mirror medline-source.ts:124-129 + retry.ts:85-86,93-94):**
```typescript
export class WhoopClient {
  constructor(
    private readonly egress: EgressGuard,
    private readonly tokenStore: WhoopTokenStore,
    private readonly fetchImpl: FetchLike = fetch as FetchLike, // default global fetch ONLY in this file
    private readonly waiter: (ms: number) => Promise<void> =
      (ms) => new Promise((resolve) => setTimeout(resolve, ms)), // injected for the 429 test (no real sleep)
  ) {}
  private cached?: { accessToken: string; expiresAtIso: string };
}
```
**Behavior contract (arch doc lines 219-220, 273-274; contract sc-2-4/sc-2-7):**
- `ensureAccessToken(): Promise<string>` — FIRST line `this.egress.assertAllowed("device-connection")`.
  If cached token is unexpired (compare `expiresAtIso` against an INJECTED `nowIso`/now, NEVER
  `Date.now()`), return it. Else read refresh token from `tokenStore`, POST `grant_type=
  refresh_token` + client creds + `scope=offline` to `WHOOP_TOKEN_URL` via `fetchImpl`, parse
  new `{ access_token, refresh_token?, expires_in }`, `tokenStore.writeTokens(...)` the rotated
  pair, cache, return. On 401/invalid_grant throw a clear "re-authorize" error.
- `fetchPage(collection, window, cursor?): Promise<WhoopPage>` — FIRST line
  `this.egress.assertAllowed("device-connection")`. GET `WHOOP_API_BASE + COLLECTION_PATHS[
  collection]` with `start`/`end` (from window) + `nextToken=cursor` query params + `Authorization:
  Bearer <token>`. On `status === 401`: call `ensureAccessToken` (force refresh) and retry
  EXACTLY ONCE. On `status === 429`: read `res.headers.get("X-RateLimit-Reset")` (seconds),
  `await this.waiter(seconds * 1000)`, then retry. Parse JSON into `{ records, nextCursor }`.
**Imports:** `import type { EgressGuard } from "../egress.js";`,
`import type { WhoopTokenStore } from "./whoop-token.js";`. The `fetch` global is allowed ONLY
here once the ESLint exception is added (step below).

---

### src/medical/whoop/whoop-client.test.ts (create)

Mirror `src/medical/retrieval/medline-source.test.ts` fixture-injection (Pattern 4) +
`src/orchestrator/workflow/retry.test.ts` recording-sleep waiter (Pattern 3).

---

### eslint.config.js (modify)

**Current single-exception block (lines 99-106):**
```javascript
{
  // ADR-6 single exception: the ONE designated retrieval network file. S7 puts the real MedlinePlus call here.
  files: ["src/medical/retrieval/medline-source.ts"],
  rules: {
    "no-restricted-imports": "off",
    "no-restricted-globals": "off",
  },
},
```
=> add `"src/medical/whoop/whoop-client.ts"` to the `files` array:
`files: ["src/medical/retrieval/medline-source.ts", "src/medical/whoop/whoop-client.ts"],`.
The scoped `src/medical/**` ban block (lines 70-98) stays untouched so whoop-token.ts +
the tests remain network-forbidden. Do NOT broaden the ban block; add ONLY this one file.

---

## 2. Patterns to Follow

### Pattern 1 — Exhaustive switch + compile-time never guard
**Source:** factory.ts uses `switch (resolvedProvider)` with `case`/`default` (factory.ts:94-147).
The codebase's never-guard idiom: a `default` branch that assigns the discriminant to a `never`.
**Rule:** Replace the egress.ts:33-35 ternary with:
```typescript
isAllowed(axis: EgressAxis): boolean {
  switch (axis) {
    case "cloud-inference":
      return this.cloudInference;
    case "literature-retrieval":
      return this.literatureRetrieval;
    case "device-connection":
      return this.deviceConnection;
    default: {
      const _exhaustive: never = axis; // compile error if an EgressAxis value is unhandled
      return _exhaustive;
    }
  }
}
```
If a future axis is added without a `case`, `_exhaustive: never = axis` fails to compile (sc-2-1).

### Pattern 2 — Injectable transport + assertAllowed BEFORE fetch
**Source:** `src/medical/retrieval/medline-source.ts:37-39` (FetchLike), `:46` (module const base),
`:124-129` (constructor injects `fetchImpl = fetch as FetchLike`), `:144-148` (assertAllowed FIRST,
then `fetchImpl(url)`).
```typescript
async fetchPassages(query: string): Promise<RetrievalOutcome> {
  try {
    this.egress.assertAllowed("literature-retrieval"); // MUST be first
    const url = buildMedlineUrl(query);
    const res = await this.fetchImpl(url);
    if (!res.ok) return { kind: "abstain", reason: "source-error" };
    ...
```
**Rule:** `assertAllowed("device-connection")` is the FIRST statement of BOTH `ensureAccessToken`
and `fetchPage`, before ANY `fetchImpl` call. With the axis off it throws and `fetchImpl` is
never invoked (sc-2-4). NOTE: unlike MedlineSource, WhoopClient does NOT swallow errors — it
THROWS (arch doc lines 219-220: "401/invalid_grant ⇒ throw", "5xx/network ⇒ throw").

### Pattern 3 — Injected no-wait waiter (NEVER real sleep)
**Source:** `src/orchestrator/workflow/retry.ts:85-86,93-94,112,125` (injectable `sleep?: (ms) =>
Promise<void>` defaulting to setTimeout) and its test `retry.test.ts:12-22`:
```typescript
function recordingSleep() {
  const delays: number[] = [];
  return { delays, sleep: (ms: number): Promise<void> => { delays.push(ms); return Promise.resolve(); } };
}
```
**Rule:** WhoopClient takes a `waiter: (ms: number) => Promise<void>` constructor param
defaulting to setTimeout. The 429 test injects a recording waiter, asserts it was called with
`resetSeconds * 1000`, and never actually sleeps.

### Pattern 4 — Fixture-driven fake FetchLike (no real network)
**Source:** `src/medical/retrieval/medline-source.test.ts:25-37`:
```typescript
function makeFakeFetch(body: unknown, ok = true, status = 200): FetchLike {
  return async () => ({ ok, status, json: async () => body });
}
```
**Rule:** WHOOP fakes must also return `headers: { get: (n) => n === "X-RateLimit-Reset" ? "2" : null }`
(the medline shape lacks `headers` — the WHOOP FetchLike adds it). For pagination/401/429 tests
use a stateful fake that returns different responses on successive calls (e.g. a queue of
responses or a call-counter), so page-1 returns `nextCursor`, page-2 returns none; or first
call 401, second 200; or first 429, second 200.

### Pattern 5 — 0600 JSON sidecar write/read under .bober/medical
**Source:** `src/medical/consent.ts:75-81` (writeFile + `{ mode: 0o600 }` after `ensureDir`),
`:47-65` (try/catch read => undefined on missing/corrupt). `src/medical/audit.ts:44-58` shows
the stronger `open(path, O_WRONLY|O_APPEND|O_CREAT, 0o600)` + `fh.chmod(0o600)` for guaranteed
mode. `src/medical/audit.ts:30-32,45` shows the `join(projectRoot, ".bober", "medical", file)`
path idiom.
**Rule:** Use the consent.ts `writeFile({mode:0o600})` form for whoop-token.json; fall back to
the audit.ts `open`+`chmod` form only if the mode test fails on overwrite.

### Pattern 6 — process.env credential read + clear throw
**Source:** `src/providers/factory.ts:96-102`:
```typescript
const key = apiKey ?? process.env["ANTHROPIC_API_KEY"];
if (!key) {
  throw new Error(
    `${roleLabel} is configured to use Anthropic but ANTHROPIC_API_KEY is not set. ` +
      `Set the ANTHROPIC_API_KEY environment variable and try again.`,
  );
}
```
**Rule:** `clientCredentials()` reads `process.env["WHOOP_CLIENT_ID"]`/`["WHOOP_CLIENT_SECRET"]`
(bracket access — strict `noUncheckedIndexedAccess` style used throughout) and throws a message
naming BOTH env vars when either is unset (sc-2-6).

### Pattern 7 — Section comments (principles.md line 32)
**Rule:** Use unicode box headers `// ── Section Name ──────` in every new file. See
medline-source.ts:6,41,54,106 and audit.ts:7,24,35.

### Pattern 8 — Header docblock referencing the ADR
**Source:** medline-source.ts:1-3, audit.ts:1, consent.ts:1.
**Rule:** First line of whoop-client.ts notes it is the SECOND ESLint-excepted network file
(ADR-1); whoop-token.ts notes env creds + 0600 sidecar, no network (ADR-2).

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `ensureDir` | `src/utils/fs.ts:45-47` | `(path: string): Promise<void>` | mkdir recursive; use before writing whoop-token.json |
| `writeJson` | `src/utils/fs.ts:34-40` | `(path: string, data: unknown): Promise<void>` | ensureDir + writeFile JSON (NOTE: no mode arg — use raw writeFile w/ 0o600 for the 0600 sidecar, NOT this) |
| `EgressGuard` | `src/medical/egress.ts:17-46` | class `{ isAllowed; assertAllowed; static fromConfig }` | The axis gate — EXTEND it, do not fork it |
| `EgressGuard.assertAllowed` | `src/medical/egress.ts:41-45` | `(axis: EgressAxis): void` throws | Call before any HTTP in WhoopClient |
| `FetchLike` (medline) | `src/medical/retrieval/medline-source.ts:37-39` | `(url) => Promise<{ok,status,json}>` | Reference shape; WHOOP needs an EXTENDED variant (adds init + headers) — define a new one in whoop-client.ts |
| `withRetry` / injected `sleep` | `src/orchestrator/workflow/retry.ts:103-127` | `(fn, opts)` | Reference for the injected-waiter pattern; do NOT import (429 is a single Reset-wait, not exponential backoff) |
| `AuditLog` 0600 write | `src/medical/audit.ts:44-58` | `open(...,0o600)+fh.chmod` | The strong-guarantee 0600 write template |
| `ConsentGate` sidecar | `src/medical/consent.ts:47-87` | JSON read=>undefined / writeFile 0600 | The closest JSON-sidecar read+write template for whoop-token.ts |
| `MedlineSource` | `src/medical/retrieval/medline-source.ts:123-165` | class w/ injectable fetchImpl | The network-file structural template for whoop-client.ts |

Utilities reviewed: `src/utils/` (fs.ts, git.ts, logger.ts) — only fs.ts (`ensureDir`,
`writeJson`) is relevant. No HTTP/OAuth helper exists in the repo (none expected — ADR-2 keeps
transport in the one excepted file). Do NOT add undici/axios/node-fetch (banned + no new deps).

---

## 4. Prior Sprint Output

### Sprint 1 (commit 2a8ff70): RefusalDetector + guardrails refuse + engine dispatch
**Created:** `src/medical/refusal.ts` (RefusalDetector), edits to `guardrails.ts`/`engine.ts`.
**Connection to this sprint:** NONE on egress/schema — Sprint 1 explicitly did NOT touch
`egress.ts` or `schema.ts`, so this sprint starts from the base 2-axis EgressGuard shown in §1.
No imports from Sprint 1 are needed here.

### Base medical team (commits up to 553f087/3f91217): EgressGuard + MedlineSource + AuditLog
**Created:** `src/medical/egress.ts` (2 axes), `src/medical/retrieval/medline-source.ts`
(THE network template, single ESLint exception), `src/medical/audit.ts` (0600 write),
`src/medical/consent.ts` (0600 JSON sidecar), `eslint.config.js` medical ban + exception.
**Connection to this sprint:** This sprint extends EgressGuard (3rd axis), adds the SECOND
ESLint exception sibling to medline-source.ts, and reuses the audit/consent 0600 + ensureDir +
`.bober/medical` path patterns for whoop-token.json.

---

## 5. Relevant Documentation

### Project Principles (.bober/principles.md)
- ESM everywhere; ALL imports use `.js` extensions (NodeNext). From `src/medical/whoop/` to
  `src/utils/fs.ts` is `../../utils/fs.js` (TWO levels up — easy to get wrong). To `../egress.js`
  is one level up. (principles.md:27)
- `import type { ... }` for type-only imports (`consistent-type-imports` ESLint error). EgressGuard
  and WhoopTokenStore are imported as TYPES in whoop-client.ts. (principles.md:35, 19)
- No synchronous fs — `node:fs/promises` only (principles.md:42). audit.ts/consent.ts comply.
- No `any` (warning); use `unknown` + narrowing — medline-source.ts:60-104 is the model for
  parsing unknown JSON into typed records. (principles.md:40)
- Section comments `// ── Name ──` (principles.md:32). Prefix unused params with `_` (principles.md:36).
- Tests collocated `*.test.ts`; no fs mocks — use mkdtemp temp dirs + cleanup (principles.md:20, 44).
- Zod for config; add the flag to `config/schema.ts`, never hand-roll (principles.md:29).

### Architecture Decisions (this spec)
- **ADR-1** (arch-...-whoop-guardrails-adr-1.md): WHOOP behind a NEW third egress axis
  `"device-connection"` (default false, INDEPENDENT of the other two); all HTTP in ONE new
  ESLint-excepted file `src/medical/whoop/whoop-client.ts`; pull-based, no webhooks.
- **ADR-2** (adr-2.md): creds via `process.env` (mirror factory.ts:96-136); refresh token in a
  SEPARATE `WhoopTokenStore` at `.bober/medical/whoop-token.json` mode 0600 (mirror audit.ts:50,
  consent.ts:30); `WhoopClient` stays PURE transport — NO credential file I/O inside it; an
  unauthorized state (no refresh token) yields a clear authorize-first message, not a crash.
- **ADR-4** (adr-4.md): no cross-page transaction; idempotent resume via content-derived dedup —
  this is Sprint 3 scope; do NOT add a persisted cursor this sprint (nonGoal).
- **Arch component specs** (architecture.md:51-117): exact `WhoopClient`/`WhoopTokenStore`/
  `EgressGuard` interfaces + the extended `FetchLike` (with `init` + `headers.get`) are quoted in §1.

---

## 6. Testing Patterns

### Unit Test — temp dir + fs.stat 0600 (for whoop-token.test.ts)
**Source:** `src/medical/audit.test.ts:1-18, 48-58`
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-whoop-token-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); vi.restoreAllMocks(); });

it("written token file has mode 0600 on POSIX", async () => {
  if (process.platform === "win32") return;
  const store = new WhoopTokenStore(tmpDir);
  await store.writeTokens({ accessToken: "a", refreshToken: "r", expiresAtIso: "2026-06-17T00:00:00.000Z" });
  const s = await stat(join(tmpDir, ".bober", "medical", "whoop-token.json"));
  expect(s.mode & 0o777).toBe(0o600);
});
```

### Unit Test — env stub save/delete/restore (for clientCredentials test)
**Source:** `src/providers/factory.test.ts:209-216`
```typescript
it("throws when WHOOP creds unset", () => {
  const savedId = process.env["WHOOP_CLIENT_ID"];
  const savedSecret = process.env["WHOOP_CLIENT_SECRET"];
  delete process.env["WHOOP_CLIENT_ID"];
  delete process.env["WHOOP_CLIENT_SECRET"];
  try {
    expect(() => new WhoopTokenStore("/tmp").clientCredentials())
      .toThrow(/WHOOP_CLIENT_ID/);
  } finally {
    if (savedId !== undefined) process.env["WHOOP_CLIENT_ID"] = savedId;
    if (savedSecret !== undefined) process.env["WHOOP_CLIENT_SECRET"] = savedSecret;
  }
});
```
(`vi.stubEnv` is an alternative, but the repo's medical/provider tests use the explicit
save/delete/restore idiom — match it for consistency.)

### Unit Test — fixture FetchLike + recording waiter (for whoop-client.test.ts)
**Source:** medline-source.test.ts:25-37 + retry.test.ts:12-22
```typescript
function recordingWaiter() {
  const waited: number[] = [];
  return { waited, wait: (ms: number) => { waited.push(ms); return Promise.resolve(); } };
}
function makeResponse(body: unknown, opts: { ok?: boolean; status?: number; reset?: string } = {}) {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: { get: (n: string) => (n === "X-RateLimit-Reset" ? (opts.reset ?? null) : null) },
    json: async () => body,
  };
}
// queue-based stateful fake: returns responses[i] on the i-th call
function makeQueueFetch(responses: ReturnType<typeof makeResponse>[]): FetchLike {
  let i = 0;
  return async () => responses[Math.min(i++, responses.length - 1)]!;
}
```
**Required test cases (sc-2-4, sc-2-7):**
1. axis OFF: `new EgressGuard(false, false, false)` => `ensureAccessToken()` AND `fetchPage(...)`
   both reject with `/device-connection/` and a fetch SPY records 0 calls.
2. pagination: page-1 fixture has `nextCursor`, page-2 has none — driver walks the cursor to end.
3. 401: first GET 401, refresh POST 200, second GET 200 — assert refresh fetch called EXACTLY once.
4. 429: first GET 429 w/ `X-RateLimit-Reset: 2`, assert `waited` contains `2000`, second GET 200.

**Runner:** vitest. **Assertion:** `expect(...)`. **Mock:** injected fakes (NO `vi.mock` of fetch —
fetch is banned in test files under src/medical; use duck-typed FetchLike fakes, medline-source.test.ts:1-7).
**File naming:** `*.test.ts` collocated. **Location:** next to source in `src/medical/whoop/`.

### E2E Test Pattern
Not applicable — no Playwright/E2E for this backend module.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/medical/egress.test.ts` | `EgressGuard` ctor (2 args) | HIGH | 2-arg `new EgressGuard(...)` calls (lines 9,25,33,40,49 etc.) — break if 3rd param is REQUIRED. Make 3rd param OPTIONAL (`= false`). |
| `src/medical/retrieval/medline-source.ts` | `import type { EgressGuard }`, `assertAllowed` | LOW | Type-only import; switch refactor is source-compatible. Verify medline-source.test.ts still green. |
| `src/medical/retrieval/literature.ts` | `EgressGuard` | LOW | Uses isAllowed/assertAllowed — switch preserves both existing arms verbatim. |
| `src/medical/engine.ts` (engine.ts:384 calls `EgressGuard.fromConfig`) | `EgressGuard.fromConfig` | LOW | fromConfig signature unchanged (still `(config)`); only adds a 3rd internal arg. NOTE: team.ts does NOT import egress. |
| `src/config/loader.ts` + config consumers | `MedicalSectionSchema` | LOW | New optional field with default false — existing configs parse unchanged. |
| `eslint.config.js` ban block (lines 70-98) | all src/medical/**.ts | MEDIUM | whoop-token.ts + the new tests MUST stay under the ban (no network). Only whoop-client.ts gets the exception. |

### Existing Tests That Must Still Pass
- `src/medical/egress.test.ts` — the sc-6-5 two-axis suite; verify all 2-arg ctor calls compile
  and `fromConfig` still defaults both original axes false (lines 7-67).
- `src/medical/retrieval/medline-source.test.ts` — verifies `assertAllowed("literature-retrieval")`
  behavior; the switch refactor must not change the literature arm (lines 41-137).
- `src/medical/audit.test.ts`, `src/medical/consent.test.ts` — confirm the 0600/sidecar patterns
  you mirror still pass (no shared code is modified, but they validate the pattern).
- Full medical suite (`engine.test.ts`, `team.test.ts`, `guardrails.test.ts`) — EgressGuard is
  wired through the engine; the additive third axis must not alter the two existing arms.

### Features That Could Be Affected
- **literature-retrieval / cloud-inference egress** — share `EgressGuard`. Verify the independence
  matrix: enabling ONLY `device-connection` leaves the other two false, and vice-versa (sc-2-3).
- **Sprint 3 WhoopSyncAdapter** (future) — will consume `WhoopClient.fetchPage`; keep the
  `WhoopPage`/`WhoopCollection`/`SyncWindow` shapes exactly as in arch doc lines 56-66.

### Recommended Regression Checks (run after implementation)
1. `npm run typecheck` — strict; the `_exhaustive: never = axis` line must compile (sc-2-1).
2. `npm run build` — zero tsc errors.
3. `npx vitest run src/medical/egress.test.ts src/medical/whoop` — new + existing axis/token/client tests.
4. `npx vitest run src/medical` — full medical suite (no regression in engine/team/medline).
5. `npm run lint` — passes WITH the new whoop-client.ts exception; whoop-token.ts stays banned.
6. Grep guard (sc-2-5):
   `grep -rEn 'node:http|node:https|node:net|undici|axios|node-fetch' src/medical --include='*.ts' | grep -v whoop-client.ts`
   => expect ZERO production network usage outside whoop-client.ts.

---

## 8. Implementation Sequence

1. **src/config/schema.ts** — add `deviceConnection: z.boolean().default(false)` to the medical
   egress object (lines 376-385). No dependencies.
   - Verify: `npm run typecheck` clean; `BoberConfig` now has `medical.egress.deviceConnection`.
2. **src/medical/egress.ts** — extend the union (line 5), add OPTIONAL 3rd ctor param (`= false`),
   add the 3rd `fromConfig` arg, rewrite `isAllowed` as the exhaustive switch + never guard.
   Keep `assertAllowed` as-is.
   - Verify: typecheck clean (never guard compiles); existing 2-arg `new EgressGuard(...)` still valid.
3. **src/medical/egress.test.ts** — add three-axis flag, independence-matrix, and fromConfig
   default-false-for-device tests. Update any 2-arg ctor calls if you made the 3rd param required
   (preferably you did NOT — keep it optional).
   - Verify: `npx vitest run src/medical/egress.test.ts` green (old + new).
4. **src/medical/whoop/whoop-token.ts** — create (NO network). clientCredentials (env+throw),
   readRefreshToken (=>undefined on absent), writeTokens (0600). Imports `ensureDir` from
   `../../utils/fs.js`.
   - Verify: typecheck clean; `grep node:http... whoop-token.ts` => nothing.
5. **src/medical/whoop/whoop-token.test.ts** — env-stub throw, mkdtemp + fs.stat 0600,
   read absent=>undefined / present=>token.
   - Verify: `npx vitest run src/medical/whoop/whoop-token.test.ts` green.
6. **src/medical/whoop/whoop-client.ts** — create (the network file). Types, module consts,
   constructor (egress, tokenStore, fetchImpl?, waiter?), ensureAccessToken (assertAllowed first,
   refresh grant, persist rotated tokens), fetchPage (assertAllowed first, GET + cursor, 401
   refresh-retry-once, 429 Reset-wait via waiter, parse to WhoopPage).
   - Verify: typecheck clean. (Will FAIL lint until step 7 adds the exception.)
7. **eslint.config.js** — add `"src/medical/whoop/whoop-client.ts"` to the exception `files` array
   (line 101).
   - Verify: `npm run lint` clean; whoop-token.ts + tests still banned from network.
8. **src/medical/whoop/whoop-client.test.ts** — axis-off throw + 0 fetch calls; pagination;
   401-refresh-retry-once; 429-Reset-wait via recording waiter. Fixture-driven, no real network/sleep.
   - Verify: `npx vitest run src/medical/whoop/whoop-client.test.ts` green.
9. **Run full verification** — `npm run build`, `npm run typecheck`, `npx vitest run src/medical`,
   `npm run lint`, and the §7 grep guard.

---

## 9. Pitfalls & Warnings

- **isAllowed is a TERNARY, not a switch.** egress.ts:33-35 has no never guard and would route
  `"device-connection"` into the literature branch. You MUST convert to a switch (Pattern 1).
- **Third ctor param breaks existing 2-arg calls.** egress.test.ts + base call sites pass 2 args.
  Make `deviceConnection` an OPTIONAL param with `= false` default so the existing two arms stay
  byte-identical and existing tests compile (contract: "existing egress tests unchanged").
- **whoop-token.ts must NOT import anything network.** Only whoop-client.ts gets the ESLint
  exception. No `node:http(s)`, no `fetch`, no undici in whoop-token.ts or the tests. (sc-2-5)
- **The medline FetchLike has NO `headers`.** Define an EXTENDED FetchLike in whoop-client.ts with
  `init?` and `headers: { get(name): string | null }` — needed for the 429 Reset header and the
  POST refresh body. (arch doc lines 65-66)
- **NEVER use Date.now() for token expiry.** now/timestamps are INJECTED (contract assumption #5,
  audit.ts:30-32 precedent). Accept an injected `nowIso` (or compare against a passed-in clock)
  so the 401/expiry tests are deterministic.
- **429 must await an INJECTED waiter, never real setTimeout in tests.** Constructor takes a
  `waiter` param defaulting to setTimeout; the test injects a recording no-wait waiter and asserts
  it received `resetSeconds * 1000`. (Pattern 3, sc-2-7)
- **401 triggers EXACTLY ONE refresh+retry.** Use a one-shot retry flag/loop guard — a second 401
  must NOT loop again; it throws "re-authorize". (arch doc lines 219-220)
- **WHOOP v2 endpoint paths are non-obvious:** recovery=`/v2/recovery`, sleep=`/v2/activity/sleep`,
  cycle=`/v2/cycle`, workout=`/v2/activity/workout` (note sleep+workout are under `/v2/activity/`).
- **`.js` import extension + correct depth.** From `src/medical/whoop/` it's `../../utils/fs.js`
  (TWO up) and `../egress.js` (ONE up). Omitting `.js` or wrong depth = NodeNext runtime failure.
- **assertAllowed BEFORE any fetchImpl in BOTH methods.** sc-2-4 asserts the fetch spy records 0
  calls when the axis is off — a single misplaced fetch before the guard fails the criterion.
- **writeFile mode only applies on create.** If the token-mode test overwrites an existing file,
  switch to the audit.ts `open(...,0o600)+fh.chmod(0o600)` form. Do NOT use `appendFile` (ignores mode).
- **eslint exception is a `files` ARRAY append, not a new block.** Add the path to the existing
  array at line 101; do not duplicate the whole override block.
- **No new runtime deps.** Use the injectable `FetchLike` defaulting to global `fetch`; do NOT add
  undici/axios/node-fetch (banned by the ban block AND by "no new runtime deps").
