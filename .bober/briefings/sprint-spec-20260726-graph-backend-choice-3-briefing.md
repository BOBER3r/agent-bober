# Sprint Briefing: Backend selection — graph.backend config + auto-detection + wire 5 sites + additive manifest

**Contract:** sprint-spec-20260726-graph-backend-choice-3
**Generated:** 2026-07-27T00:00:00Z

---

## 0. TL;DR for the Generator

You are making backend SELECTION dynamic. After Sprints 1-2 the `GraphBackend` seam exists and
`TokensaveBackend` implements it, but all 5 construction sites hardcode `new TokensaveBackend()`.
This sprint: (1) add optional `graph.backend` + `graph.codeReviewGraphPath` to the schema, (2) add a
`code-review-graph` STUB backend, (3) add a registry + `resolveGraphBackend()` that probes binaries,
(4) rewire the 5 sites to `await resolveGraphBackend(...)`, (5) evolve `GraphManifest` additively with
legacy read. **The single most important invariant: with `graph.backend` UNSET and tokensave installed,
every path must be byte-identical to today** — this is enforced by an explicit golden snapshot test
(see §7). Do NOT `.default(...)` the new schema fields.

---

## 1. Target Files

### `src/config/schema.ts` (modify)

**Relevant section — `GraphSectionSchema`, lines 394-418:**
```ts
export const GraphSectionSchema = z.object({
  enabled: z.boolean().default(false),
  tokensavePath: z.string().optional(),
  autoSync: z.boolean().default(true),
  languageTier: GraphLanguageTierSchema.default("core"),
  manifestPath: z.string().default(".bober/graph/manifest.json"),
  // ... syncTimeoutMs, queryTimeoutMs, debounceMs, hookQueueMax, maxEngineRssMb ...
  exposeOnExternalMcp: z.boolean().default(true),
  preflightBudgets: GraphPreflightBudgetsSchema.default({ /* ... */ }),
});
export type GraphSection = z.infer<typeof GraphSectionSchema>;
```
**Where to add** (mirror the existing optional `tokensavePath: z.string().optional()` at line 396):
```ts
  /** Explicit engine override. Unset = auto-detect (tokensave preferred). */
  backend: z.enum(["tokensave", "code-review-graph"]).optional(),
  /** Custom code-review-graph binary path (mirrors tokensavePath). */
  codeReviewGraphPath: z.string().optional(),
```
**CRITICAL:** use `.optional()` with **NO `.default(...)`**. An optional-without-default zod field is
*absent* from the parsed object when the input omits it, so the golden snapshot in §7 stays green.
Adding `.default("tokensave")` would materialize the key and BREAK the snapshot test.

**Imports this file uses:** `z` from `"zod"` (already imported at top).
**Imported by:** `src/graph/types.ts:5` (`GraphSection = z.infer<typeof GraphSectionSchema>`), plus config loader/consumers.
**Test file:** `src/config/schema.test.ts` (exists — has the golden snapshot at line 879) AND `tests/config/graph-schema.test.ts` (exists — the graph back-compat suite).

---

### `src/graph/types.ts` (modify) — `GraphManifest`

**Relevant section — lines 13-22:**
```ts
export type GraphManifest = {
  schemaVersion: 1;
  tokensaveVersion: string;
  createdAt: string;
  lastSyncAt: string;
  indexedFileCount: number;
  languageTier: string;
  lastSyncedHeadSha: string | null;
  pendingFiles: string[];
};
```
**Add additively** (keep `tokensaveVersion` — nonGoal forbids removing it):
```ts
  backend: string;         // 'tokensave' | 'code-review-graph'
  backendVersion: string;  // resolved engine version
```
**WARNING — this is a REQUIRED-field addition.** Every full-literal `writeManifest({...})` call site
must now supply `backend` + `backendVersion` or typecheck fails. Spread sites (`{ ...existing, ... }`)
are fine. See §7 for the exact list.

---

### `src/graph/artifact-store.ts` (modify) — legacy manifest read

**Relevant section — `readManifest`, lines 24-35 (currently a raw cast, no normalization):**
```ts
  async readManifest(): Promise<GraphManifest | null> {
    if (!(await fileExists(this.manifestPath))) return null;
    try {
      return await readJson<GraphManifest>(this.manifestPath);   // <-- add normalization here
    } catch (err) { /* logs + returns null */ }
  }
```
**Change:** after `readJson`, normalize legacy manifests before returning (sc-3-7):
```ts
    const raw = await readJson<Partial<GraphManifest>>(this.manifestPath);
    return {
      ...raw,
      backend: raw.backend ?? "tokensave",
      backendVersion: raw.backendVersion ?? raw.tokensaveVersion ?? "",
    } as GraphManifest;
```
`writeManifest` (lines 37-40) needs no logic change — it writes whatever object it is handed (which now
carries `backend`/`backendVersion`).

---

### `src/graph/pipeline-lifecycle.ts` (modify) — construction site #1 (the async one)

**`start()` — lines 63-113.** Key lines to rewire:
- Prereq check hardcodes tokensave — lines 78-81:
```ts
    const prereq = await new TokensavePrereqCheck(
      cfg.tokensavePath ?? "tokensave",
    ).check();
```
- Backend + transport hardcoded — lines 96-104:
```ts
    this.backend = new TokensaveBackend();
    this.mcpClient = new TokensaveMcpClient(
      projectRoot, cfg, this.incidents, this.backend.processSpec(),
    );
```
- CLI hardcodes tokensave binary — lines 108-113:
```ts
    const cli = new TokensaveCli(projectRoot, this.store, cfg.tokensavePath ?? "tokensave");
```
**Rewire:** `const backend = await resolveGraphBackend(config, ...)` near the top of the enabled branch,
then run the prereq via `new GenericPrereqCheck(binary, backend.prereqSpec())`, store `this.backend = backend`,
and pass `backend.processSpec()` into `TokensaveMcpClient`.
- The field type is `private backend: TokensaveBackend | null` (line 46) and `getGraphClient()` at
  line 253 uses `this.backend ?? new TokensaveBackend()`. Widen the field type to `GraphBackend | null`.
- `_reset()` (line 284) sets `this.backend = null` — no change.
- **Do NOT touch** the inline `GraphSection` stub at lines 234-252 (getGraphClient). Per the contract
  assumption: "the backend is a SEPARATE injected dependency from the GraphSection config" — the stub
  config object is passed as the 7th arg, the backend as the 8th (`this.backend ?? ...`).

**Imported by:** `src/orchestrator/tools/index.ts` (resolveRoleTools), pipeline runner. **Test:** `tests/graph/pipeline-lifecycle.test.ts` (exists).

---

### `src/mcp/server.ts` (modify) — construction site #2

**Relevant section — lines 84-112** (inside a `try` in `createBoberMCPServer`, dynamic imports):
```ts
    const { TokensaveBackend } = await import("../graph/backends/tokensave-backend.js");
    // ...
    const backend = new TokensaveBackend();                     // line 95
    const mcpClient = new TokensaveMcpClient(projectRoot, cfg, incidents, backend.processSpec());
    const client = new GraphClient(projectRoot, mcpClient, store, graphFallback, incidents, cfg, backend);
```
**Rewire:** replace the `TokensaveBackend` dynamic import + `new TokensaveBackend()` with a dynamic import
of the registry and `const backend = await resolveGraphBackend(config, ...)`. Pass `backend` into both
`TokensaveMcpClient` (via `backend.processSpec()`) and `GraphClient` (7th arg). `createBoberMCPServer` is
already `async` (line 57).

---

### `src/cli/commands/onboard.ts` (modify) — construction site #3

**Relevant lines:** prereq at 71 (`new TokensavePrereqCheck(graphCfg.tokensavePath ?? "tokensave")`),
backend at 86 (`const backend = new TokensaveBackend()`), transport at 89-94, `GraphClient` at 109-117.
Action callback is `async`. Same rewire: resolve backend, run prereq via the backend's `prereqSpec()`,
pass backend down. Note line 137 reads `manifest?.tokensaveVersion` for the onboarding status — leave as-is
(back-compat field is still written). **Onboard must still write 5 files byte-identically** (sc-3-8 / evaluator).

### `src/cli/commands/impact.ts` (modify) — construction site #4

Structurally identical to onboard: prereq at 102, `new TokensaveBackend()` at 117, transport at 120-125,
`GraphClient` at 140-148. Same rewire.

### `src/cli/commands/graph.ts` (modify) — construction site #5 (+ 2 manifest writers)

- `check-prereq` action (lines 43-49): `new TokensavePrereqCheck()` — resolve backend, use its prereqSpec.
- `init`/`sync`/`status` (lines 77, 157, 234): each does `new TokensavePrereqCheck(graphCfg.tokensavePath ?? "tokensave")`
  and `new TokensaveCli(...)`. Rewire prereq to the resolved backend.
- **Two full-literal manifest writes** must add `backend` + `backendVersion`: `init` at **lines 112-122**
  and `sync` at **lines 186-196**. Set `backend: backend.id, backendVersion: prereq.version`.

---

## 2. Files to CREATE

### `src/graph/backends/code-review-graph-backend.ts` (create) — STUB

**Directory pattern:** `src/graph/backends/` uses kebab-case filenames (`tokensave-backend.ts`, `types.ts`).
**Template:** follow `src/graph/backends/tokensave-backend.ts` structure (imports → specs → class `implements GraphBackend`).
**Stub shape** (id + process/prereq/cli specs only; the 6 `*Plan` adapters THROW — filled Sprints 4-6):
```ts
import type { ImpactReport, NodeRef, SearchHit } from "../types.js";
import type { CallPlan, CliMap, GraphBackend, Platform, PrereqSpec, ProcessSpec, QueryPattern, SearchOpts } from "./types.js";

const NOT_IMPL = "code-review-graph adapter not implemented until Sprints 4-6";

export class CodeReviewGraphBackend implements GraphBackend {
  readonly id = "code-review-graph";

  searchPlan(_q: string, _o?: SearchOpts): CallPlan<SearchHit[]> { throw new Error(NOT_IMPL); }
  queryPlan(_p: QueryPattern, _t: NodeRef): CallPlan<NodeRef[]> { throw new Error(NOT_IMPL); }
  impactPlan(_t: NodeRef | string): CallPlan<ImpactReport> { throw new Error(NOT_IMPL); }
  reviewContextPlan(_n: NodeRef[]): CallPlan<string> { throw new Error(NOT_IMPL); }
  overviewPlan(): CallPlan<string> { throw new Error(NOT_IMPL); }
  changesPlan(_s?: string): CallPlan<NodeRef[]> { throw new Error(NOT_IMPL); }

  processSpec(): ProcessSpec { return { binary: "code-review-graph", serveArgs: ["serve"] }; }

  prereqSpec(): PrereqSpec {
    return {
      versionArgs: ["--version"],
      isCompatible: (_v) => true,                                  // accept-any TODO (documented)
      installHint: (_p: Platform) => "pip install code-review-graph",
      incompatibleHint: (detected) => `code-review-graph ${detected} version gate is a TODO (Sprints 4-6)`,
    };
  }

  cliMap(): CliMap { throw new Error(NOT_IMPL); }  // TODO Sprints 4-6
}
```
Match the exact `GraphBackend` interface at `src/graph/backends/types.ts:78-95` — `Platform` type is at
`types.ts:28`, `ProcessSpec` at 31-34, `PrereqSpec` at 37-43 (note it requires `incompatibleHint`), `CliMap` at 46-52.

### `src/graph/backends/registry.ts` (create) — the registry + resolver

**No registry/index exists in `src/graph/backends/` today** (only `types.ts` + `tokensave-backend.ts`).
Recommended shape (injectable probe for testability):
```ts
import type { BoberConfig } from "../../config/schema.js";
import type { GraphBackend } from "./types.js";
import { TokensaveBackend } from "./tokensave-backend.js";
import { CodeReviewGraphBackend } from "./code-review-graph-backend.js";

export const KNOWN_BACKENDS: readonly GraphBackend[] = [
  new TokensaveBackend(),          // preference order: tokensave FIRST
  new CodeReviewGraphBackend(),
];

/** Injectable detection probe: "did `<binary> <args>` run and print a parseable version?" */
export type VersionProbe = (binary: string, args: string[]) => Promise<{ ok: boolean; version?: string }>;

export async function resolveGraphBackend(
  config: BoberConfig,
  deps: { probe?: VersionProbe } = {},
): Promise<GraphBackend> { /* see §logic below */ }
```
**Resolution logic (drives sc-3-3/3-4/3-5):**
1. If `config.graph?.backend` is set → find that backend in `KNOWN_BACKENDS` and RETURN it immediately.
   **No probe of the other engine** (sc-3-5 — evaluator rejects if an explicit value probes the other).
2. Else probe each known backend's binary (respecting per-backend path override:
   tokensave→`graph.tokensavePath`, cr-graph→`graph.codeReviewGraphPath`, else `backend.processSpec().binary`).
3. Collect installed backends; return the FIRST installed in `KNOWN_BACKENDS` order (tokensave preferred when both).
4. If NONE installed → throw a structured error whose message concatenates BOTH
   `tokensaveBackend.prereqSpec().installHint(process.platform)` AND
   `crGraphBackend.prereqSpec().installHint(process.platform)` (= `pip install code-review-graph`) — sc-3-4.

**Default probe** — mirror the version extraction in `src/graph/prereq.ts:24-38` but WITHOUT the
`isCompatible` gate (detection = "installed + parseable semver"; the compatibility gate stays in the
separate per-site prereq check per sc-3-5). Use `execa(binary, args, { reject: false, timeout: 5000 })`,
treat `exitCode === 0` + a `/(\d+\.\d+\.\d+(?:-[\w.]+)?)/` match as installed.

### Test files to CREATE
- `tests/graph/backends/registry.test.ts` — unit-test `resolveGraphBackend` with a MOCKED probe (all 5 branches).
- Extend `tests/graph/artifact-store.test.ts` — add a legacy-manifest read test (sc-3-7).

---

## 3. Patterns to Follow

### Backend implements the shared seam
**Source:** `src/graph/backends/tokensave-backend.ts`, lines 212-372.
```ts
export class TokensaveBackend implements GraphBackend {
  readonly id = "tokensave";
  // ...Plan methods returning CallPlan<T>...
  processSpec(): ProcessSpec { return { binary: "tokensave", serveArgs: ["serve"] }; }
  prereqSpec(): PrereqSpec { return { versionArgs: ["--version"], isCompatible: ..., installHint: ..., incompatibleHint: ... }; }
  cliMap(): CliMap { return { initArgs, syncArgs, statusArgs, parseSync, parseStatus }; }
}
```
**Rule:** the stub backend implements the SAME interface; only `id` + `processSpec` + `prereqSpec` need real values this sprint.

### Backend-agnostic prereq via GenericPrereqCheck (reuse, don't rebuild)
**Source:** `src/graph/prereq.ts`, lines 15-53.
```ts
export class GenericPrereqCheck {
  constructor(private readonly binary: string, private readonly spec: PrereqSpec) {}
  async check(): Promise<PrereqResult> {
    const result = await execa(this.binary, this.spec.versionArgs, { reject: false, timeout: 5000 });
    // ...extract semver, call spec.isCompatible + spec.installHint/incompatibleHint...
  }
}
```
**Rule:** the per-site prereq check becomes `new GenericPrereqCheck(binary, backend.prereqSpec()).check()`.
`TokensavePrereqCheck` (prereq.ts:62-72) is the existing tokensave-defaulted wrapper — keep it (still used by `graph check-prereq`).

### Additive config section (mirror the observability/telemetry precedent)
**Source:** the existing `tokensavePath: z.string().optional()` at `src/config/schema.ts:396` — an optional-no-default field.
**Rule:** add optional-no-default fields so the parsed object omits them when absent (keeps the golden snapshot green).

---

## 4. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `GenericPrereqCheck` | `src/graph/prereq.ts:15` | `constructor(binary, spec: PrereqSpec)` → `.check(): Promise<PrereqResult>` | Backend-agnostic version-gate probe. Reuse for both the resolver's default probe (sans isCompatible) and the per-site prereq check. |
| `TokensavePrereqCheck` | `src/graph/prereq.ts:62` | `constructor(binary?)` → `.check()` | Tokensave-defaulted wrapper over GenericPrereqCheck. Still used by `graph check-prereq`. |
| `TokensaveBackend` | `src/graph/backends/tokensave-backend.ts:212` | `new TokensaveBackend()` implements `GraphBackend` | The tokensave engine adapter; goes first in the registry. |
| `GraphArtifactStore` | `src/graph/artifact-store.ts:8` | `constructor(projectRoot, manifestRelPath?)`; `readManifest()/writeManifest(m)/staleness()` | Manifest read/write — modify `readManifest` for legacy normalization. |
| `execa` | node_modules (`import { execa } from "execa"`) | `execa(bin, args, {reject:false, timeout})` | Subprocess runner used by prereq + cli. The version probe uses it; mock it in tests via `vi.mock("execa")`. |
| `semver` | `import semver from "semver"` (used at tokensave-backend.ts:10, prereq.ts:2) | `semver.valid / semver.satisfies` | Version parse/compare. |
| `PrereqResult` / `PrereqSpec` / `ProcessSpec` / `CliMap` / `GraphBackend` types | `src/graph/types.ts:9`; `src/graph/backends/types.ts:37,31,46,78` | type-only | Shared contracts to import — do not redefine. |

**Utilities reviewed:** `src/graph/`, `src/graph/backends/`, `src/config/`, `src/utils/` (`fs.ts`, `logger.ts`).
No existing `resolveGraphBackend`/`registry` — this is genuinely new (confirmed by grep: no match in `src/graph/`).

---

## 5. Prior Sprint Output

### Sprint 1 (ae1bde7): GraphBackend interface + TokensaveBackend
**Created:** `src/graph/backends/types.ts` — exports `GraphBackend`, `CallPlan<T>`, `ProcessSpec`, `PrereqSpec`,
`CliMap`, `Platform`, `QueryPattern`, `SearchOpts`. `src/graph/backends/tokensave-backend.ts` — exports `TokensaveBackend`, `TOKENSAVE_VERSION_RANGE`.
**Connection:** the new `CodeReviewGraphBackend` implements the SAME `GraphBackend` interface; the registry holds instances of both.

### Sprint 2 (129d841): processSpec/prereqSpec/cliMap driven by injected backend
**Modified:** `src/graph/prereq.ts` (added `GenericPrereqCheck`), `src/graph/mcp-client.ts` (takes `ProcessSpec` — constructor line 118-122, reads `cfg.tokensavePath ?? processSpec.binary` at line 243), `src/graph/cli.ts` (`TokensaveCli` drives argv from `TokensaveBackend().cliMap()`), and the 5 construction sites now pass `backend.processSpec()`/`backend` but still `new TokensaveBackend()`.
**Connection:** this sprint replaces the hardcoded `new TokensaveBackend()` at all 5 sites with `await resolveGraphBackend(config)`.

---

## 6. Relevant Documentation

### Project Principles
No `.bober/principles.md` consulted for this sprint (backend-selection is a mechanical rewire). The governing
architecture doc referenced throughout the code is `.bober/architecture/arch-20260524-port-code-review-graph-architecture.md`
(cited at onboard.ts:29, impact.ts:30, graph.ts:14, and types.ts:2 "Mirrors ... §Data Model").

### Architecture Decisions
- The `GraphManifest` type comment (types.ts:1-2) states it mirrors the architecture doc's §Data Model — keep the additive change consistent.
- nonGoals (contract): do NOT add per-command `--backend` flags; config field + auto-detect ONLY.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/config/schema.test.ts:879-955` (GOLDEN SNAPSHOT) | `GraphSectionSchema` | **HIGH** | The explicit expected `graph:{...}` object (lines 937-955) has NO `backend`/`codeReviewGraphPath`. Adding them as `.optional()` (no default) keeps them absent → snapshot stays green. A `.default(...)` WILL break this test. |
| `tests/config/graph-schema.test.ts` | `GraphSectionSchema` | medium | Back-compat suite asserts `graph` parses with/without section. New optional fields must not perturb existing assertions. |
| `src/cli/commands/graph.ts:112-122, 186-196` | `GraphManifest` type | **HIGH** | Full-literal `writeManifest({...})` — MUST add `backend`+`backendVersion` or typecheck fails. |
| `src/graph/cli.ts:112-117` | `GraphManifest` type | low | Uses `{ ...existing }` spread — inherits new fields; no change needed. |
| `src/graph/hook-handler.ts:182` | `GraphManifest` type | low | Uses `{ ...existing, pendingFiles }` spread — no change needed. |
| `tests/graph/artifact-store.test.ts:24,48,74,89` | `GraphManifest` type | **HIGH** | 4 full-literal manifest objects — MUST add `backend`+`backendVersion` or the test file won't compile. |
| `src/graph/pipeline-lifecycle.ts` field `backend` (line 46) | `TokensaveBackend` type | medium | Widen `private backend: TokensaveBackend | null` → `GraphBackend | null`; check `getGraphClient` line 253 fallback still compiles. |
| `src/mcp/server.ts:83-113` | graph config gate | medium | Registration is wrapped in try/catch and only runs when `graph.enabled` — confirm resolve error surfaces via the existing catch, not a boot crash. |

### Existing Tests That Must Still Pass
- `src/config/schema.test.ts` — the sc-7-2 golden deep-equal (line 879) AND sc-1-2 golden (line 1230). Verify no drift.
- `tests/config/graph-schema.test.ts` — graph section back-compat (parses with/without graph).
- `tests/graph/prereq.test.ts` — TokensavePrereqCheck + platform hints (mocks `execa`) — unchanged behavior expected.
- `tests/graph/artifact-store.test.ts` — round-trip + staleness (will need the 4 literals updated).
- `tests/graph/pipeline-lifecycle.test.ts` — start/stop lifecycle (uses tokensave path; confirm resolve keeps it working).
- `tests/graph/backends/tokensave-backend.test.ts` — pure adapter tests (untouched).
- `tests/cli/graph-commands.test.ts` — graph CLI commands (imports prereq).

### Features That Could Be Affected
- **run pipeline** (feat-2) — `graphPipelineLifecycle.start()` is on the hot path; the async `resolveGraphBackend` must not change timing/behavior when tokensave is installed + backend unset.
- **external MCP graph tools** — `src/mcp/server.ts` conditional registration; must still register tokensave-backed graph tools.
- **onboard/impact/graph CLIs** — user-facing; onboard must still write exactly 5 files.

### Recommended Regression Checks
1. `npm run build` — typecheck clean (catches the manifest required-field additions everywhere).
2. `npx vitest run src/config/schema.test.ts` — golden snapshot NOT drifted (sc-3-2).
3. `npx vitest run tests/config/graph-schema.test.ts tests/graph` — graph + config suites green.
4. `npx vitest run tests/graph/backends/registry.test.ts tests/graph/artifact-store.test.ts` — new/updated tests.
5. `npm test` (full suite) — no NEW failures (sc-3-8).
6. `npm run lint` — clean.
7. Manual/spot: with `graph.backend` unset + tokensave present, `resolveGraphBackend` returns a `TokensaveBackend` instance (id === "tokensave").

---

## 8. Implementation Sequence (dependency-ordered)

1. **`src/config/schema.ts`** — add optional `backend` enum + `codeReviewGraphPath` to `GraphSectionSchema` (no defaults).
   - Verify: `npx vitest run src/config/schema.test.ts tests/config/graph-schema.test.ts` still green (golden snapshot unchanged).
2. **`src/graph/backends/code-review-graph-backend.ts`** — create the STUB (id + processSpec + prereqSpec real; adapters + cliMap throw).
   - Verify: `tsc` compiles it against `GraphBackend` (implements-clause satisfied).
3. **`src/graph/backends/registry.ts`** — `KNOWN_BACKENDS`, `VersionProbe`, `resolveGraphBackend(config, {probe?})`.
   - Verify: unit-test all 5 branches with a mocked probe.
4. **`src/graph/types.ts`** — add `backend`+`backendVersion` to `GraphManifest`.
   - Verify: build reveals every full-literal write site (fix them next).
5. **`src/graph/artifact-store.ts`** — normalize legacy read in `readManifest` (backend→'tokensave', backendVersion→tokensaveVersion).
   - Verify: new artifact-store legacy-read test passes (sc-3-7).
6. **Wire the 5 construction sites** (each: resolve backend → prereq via backend.prereqSpec() → pass backend down):
   `pipeline-lifecycle.ts`, `mcp/server.ts`, `cli/commands/impact.ts`, `cli/commands/graph.ts` (+ 2 manifest writers set backend/backendVersion), `cli/commands/onboard.ts`.
   - Verify: `npm run build` clean; onboard/impact/graph behave identically for tokensave.
7. **Tests** — `tests/graph/backends/registry.test.ts` (mocked probe, all branches) + update `tests/graph/artifact-store.test.ts` literals + legacy-read test.
   - Verify: `npm test`.
8. **Full verification** — `npm run build`, `npm test`, `npm run lint`.

---

## 9. Pitfalls & Warnings

- **Do NOT `.default(...)` the new schema fields.** The golden snapshot at `src/config/schema.test.ts:937-955`
  has no `backend`/`codeReviewGraphPath` — optional-no-default keeps them absent. A default materializes the key and fails sc-7-2.
- **Explicit backend must NOT probe the other engine** (sc-3-5). If `config.graph.backend` is set, return that
  backend immediately — no probe, no tokensave fallback. Evaluator explicitly rejects a probe-of-the-other on explicit selection.
- **`resolveGraphBackend` must be `async`** — it probes binaries. All 5 sites are already in async scopes
  (`start()`, `createBoberMCPServer`, `.action(async …)`).
- **`GraphManifest` fields are REQUIRED, not optional** — you must update every full-literal `writeManifest({...})`:
  `src/cli/commands/graph.ts:112-122` and `:186-196`, plus 4 literals in `tests/graph/artifact-store.test.ts`.
  Spread sites (`graph/cli.ts:112`, `hook-handler.ts:182`) are safe.
- **Detection probe ≠ compatibility gate.** The registry's probe treats "exit 0 + parseable semver" as installed
  (do not apply `isCompatible`). The version-gate stays in the per-site `GenericPrereqCheck` so an installed-but-incompatible
  tokensave still yields tokensave's INCOMPATIBLE hint, not a combined "neither installed" hint.
- **Combined hint must name BOTH engines** (sc-3-4): tokensave platform hint (`brew…`/`scoop…`/`cargo…` from
  `tokensave-backend.ts:42-51`) AND `pip install code-review-graph`. Assert BOTH substrings in the test.
- **Do NOT touch `TokensaveCli` (`src/graph/cli.ts`) or `TokensaveMcpClient` internal binary read
  (`mcp-client.ts:243`) this sprint.** `TokensaveCli` hardcodes `new TokensaveBackend().cliMap()` (line 35) and
  cr-graph's `cliMap()` throws — but cr-graph is a stub with no live CLI path this sprint, so leave these lower-level
  helpers as-is to preserve the byte-identical tokensave path. Full cr-graph CLI wiring lands in Sprints 4-6.
- **`pipeline-lifecycle.ts` getGraphClient inline stub (lines 234-252)** is a GraphSection config object, NOT the
  backend — the backend is the separate 8th arg (`this.backend ?? new TokensaveBackend()`, line 253). Do not conflate them.
- **mcp/server.ts registration is fail-soft** (try/catch, lines 80-121) — keep it that way; a resolve failure
  should be swallowed by the existing catch, never crash server boot.

---

## Test Pattern Reference

**Unit test — mocked execa probe** (from `tests/graph/prereq.test.ts:1-24`):
```ts
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
vi.mock("execa", () => ({ execa: vi.fn() }));
import { execa } from "execa";
beforeEach(() => { (execa as unknown as Mock).mockReset(); });
// mockResolvedValue({ exitCode: 0, stdout: "tokensave 6.1.1", failed: false })
```
For `registry.test.ts` prefer injecting a fake `probe` via `resolveGraphBackend(config, { probe })` (no execa mock needed):
```ts
const probe = vi.fn(async (binary: string) =>
  binary === "tokensave" ? { ok: true, version: "6.1.1" } : { ok: false });
const b = await resolveGraphBackend({ graph: { enabled: true } } as any, { probe });
expect(b.id).toBe("tokensave");
```
Cover: tokensave-only, crgraph-only, both→tokensave, neither→throws with BOTH hints, explicit 'code-review-graph'→no tokensave probe.

**Manifest round-trip / legacy read** (from `tests/graph/artifact-store.test.ts:22-38`): use `mkdtemp` tmp dir,
`writeManifest` a legacy object WITHOUT `backend`, then assert `readManifest()` yields `backend === "tokensave"`,
`backendVersion === <tokensaveVersion>`.

**Runner:** vitest · **Assertion:** `expect(...)` · **Mock:** `vi.mock` / `vi.fn` · **File naming:** `*.test.ts`
· **Location:** `tests/graph/**` mirrors `src/graph/**` (some co-located `*.test.ts` also exist under `src/`).
