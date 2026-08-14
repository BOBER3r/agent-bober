# Sprint Briefing: Fold process spec + prereq + CLI map into the backend; parameterize the transport (tokensave byte-identical)

**Contract:** sprint-spec-20260726-graph-backend-choice-2
**Generated:** 2026-07-27T00:00:00Z

> **The bar is byte-identical tokensave behavior.** You are moving engine-specific strings (`serve`, `tokensave`, the version range, the install hints, the CLI verbs, the output parsers) OUT of `mcp-client.ts` / `prereq.ts` / `cli.ts` and INTO `tokensave-backend.ts`, then driving the three runtime helpers from the backend's new spec accessors. No literal may leak; no behavior may change. Construction stays hardcoded to `TokensaveBackend` (auto-selection is Sprint 3).

---

## 1. Target Files

### src/graph/backends/types.ts (modify)

Sprint 1 interface (lines 47-57). You ADD three accessors + three spec types. Do NOT touch the existing `CallPlan`/`searchPlan`/`queryPlan`/etc. members.

**Current interface (lines 47-57):**
```ts
export interface GraphBackend {
  /** Engine identifier, e.g. "tokensave". */
  readonly id: string;

  searchPlan(q: string, opts?: SearchOpts): CallPlan<SearchHit[]>;
  queryPlan(pattern: QueryPattern, target: NodeRef): CallPlan<NodeRef[]>;
  impactPlan(target: NodeRef | string): CallPlan<ImpactReport>;
  reviewContextPlan(nodes: NodeRef[]): CallPlan<string>;
  overviewPlan(): CallPlan<string>;
  changesPlan(since?: string): CallPlan<NodeRef[]>;
}
```

**Add these types + accessors (recommended shape, matches generatorNotes):**
```ts
/** How to run the engine's long-lived MCP server. */
export interface ProcessSpec {
  binary: string;        // tokensave: "tokensave"
  serveArgs: string[];   // tokensave: ["serve"]
}

/** How to detect + version-gate the engine binary. */
export interface PrereqSpec {
  versionArgs: string[];                 // tokensave: ["--version"]
  isCompatible(version: string): boolean;
  installHint(platform: NodeJS.Platform): string;
}

/** How to run the short-lived init/sync/status CLI + parse its output. */
export interface CliMap {
  initArgs(opts: { languageTier?: string }): string[];  // tokensave: ["init"]
  syncArgs(paths: string[]): string[];                   // tokensave: ["sync", ...paths]
  statusArgs: string[];                                  // tokensave: ["status", "--json"]
  parseSync(output: string): number;                     // tokensave: parseSyncOutput
  parseStatus(stdout: string): StatusResult;             // tokensave: status JSON parsing
}
```
Then add to `GraphBackend`: `processSpec(): ProcessSpec;`, `prereqSpec(): PrereqSpec;`, `cliMap(): CliMap;`.

**Import note:** `CliMap.parseStatus` returns `StatusResult`, which today lives in `src/graph/cli.ts:10-14`. `backends/types.ts` already imports `ImpactReport, NodeRef, SearchHit` from `"../types.js"` (line 6). **Move `StatusResult` (and `SyncResult`) into `src/graph/types.ts`** and import it here via `import type { StatusResult } from "../types.js"`. Nothing outside `cli.ts` imports `StatusResult`/`SyncResult` (verified: `grep -rn "SyncResult" src/` returns only `cli.ts`), so add a back-compat re-export in `cli.ts`: `export type { SyncResult, StatusResult } from "./types.js";`.

**Imported by:** `src/graph/tokensave-backend.ts:12`, `src/graph/client.ts:27` (both type-only). Adding members is additive — GraphClient does not consume the new accessors.

**Test file:** `tests/graph/backends/tokensave-backend.test.ts` (exists — see §6).

---

### src/graph/backends/tokensave-backend.ts (modify)

Class `TokensaveBackend implements GraphBackend` (line 119). You implement the three new accessors here by **MOVING** logic verbatim from `prereq.ts` and `cli.ts`. Add a new section header (project convention, principles.md:32) e.g. `// ── Process / prereq / CLI specs ──`.

**Add methods (moving VERBATIM strings — see §2 for the exact literals):**
```ts
processSpec(): ProcessSpec {
  return { binary: "tokensave", serveArgs: ["serve"] };
}

prereqSpec(): PrereqSpec {
  return {
    versionArgs: ["--version"],
    isCompatible: (v) =>
      semver.satisfies(v, TOKENSAVE_VERSION_RANGE, { includePrerelease: true }),
    installHint: (platform) => { /* brew/scoop/cargo switch — verbatim, §2 */ },
  };
}

cliMap(): CliMap {
  return {
    initArgs: (_opts) => ["init"],       // languageTier NOT forwarded (cli.ts:36-39)
    syncArgs: (paths) => ["sync", ...paths],
    statusArgs: ["status", "--json"],
    parseSync: (out) => parseSyncOutput(out),   // moved from cli.ts:187-220
    parseStatus: (stdout) => { /* status JSON parsing — moved from cli.ts:148-173 */ },
  };
}
```
Add `import semver from "semver";` and move `const TOKENSAVE_VERSION_RANGE = ">=6.0.0-beta.1 <7.0.0";` (from prereq.ts:5) into this module. Move the `parseSyncOutput` helper (cli.ts:187-220, ANSI-strip included) as a module-private function here.

---

### src/graph/mcp-client.ts (modify)

Only TWO edits. Everything else (handshake, tools/call envelope, breaker, health, PID) is a **nonGoal** — do not touch.

**Edit 1 — constructor (lines 117-122):** replace the engine-literal default binary with an injected `ProcessSpec`.
```ts
// CURRENT:
constructor(
  private readonly projectRoot: string,
  private readonly cfg: GraphSection,
  private readonly incidents: IncidentLog,
  private readonly binary: string = "tokensave",   // ← REMOVE the "tokensave" default
) {}
// RECOMMENDED:
constructor(
  private readonly projectRoot: string,
  private readonly cfg: GraphSection,
  private readonly incidents: IncidentLog,
  private readonly processSpec: ProcessSpec,        // no default — engine specifics injected
) {}
```

**Edit 2 — spawn site (lines 241-246):** derive binary + serveArgs from the spec. Keep the `cfg.tokensavePath` override (assumption in contract).
```ts
// CURRENT (line 242):
const child = execa(this.binary, ["serve"], {
  cwd: this.projectRoot, stdio: ["pipe", "pipe", "pipe"], reject: false,
});
// RECOMMENDED:
const binary = this.cfg.tokensavePath ?? this.processSpec.binary;
const child = execa(binary, this.processSpec.serveArgs, {
  cwd: this.projectRoot, stdio: ["pipe", "pipe", "pipe"], reject: false,
});
```
Add `import type { ProcessSpec } from "./backends/types.js";`. Keep the class name `TokensaveMcpClient` (see §Design Recommendation). This satisfies **sc-2-5**: no `'tokensave'` default and no `['serve']` literal remain in the transport.

**Imported by:** `pipeline-lifecycle.ts:23`, `client.ts:11` (type-only), `mcp/server.ts:87` (dynamic import), `cli/impact.ts:20`, `cli/onboard.ts:18`. All four *value* construction sites pass a 4th arg today → must update (see §7).

**Test file:** `tests/graph/mcp-client.test.ts` (exists; ~12 constructions to update — see §6/§7).

---

### src/graph/prereq.ts (modify)

`TokensavePrereqCheck` (lines 7-64). Refactor into a backend-driven generic check while **keeping the class name + constructor signature** so `tests/graph/prereq.test.ts` stays green with zero edits (it constructs `new TokensavePrereqCheck()` with no args, and `.check()`).

**Preserve EXACTLY (do not paraphrase):** the version regex `/(\d+\.\d+\.\d+(?:-[\w.]+)?)/` (line 25), the `semver.valid` guard (line 27), `semver.satisfies(..., { includePrerelease: true })` (lines 34-38), the MISSING-on-throw / MISSING-on-nonzero branches (lines 17-22), and the incompatible-hint format string (line 62).

**Recommended:** export a `GenericPrereqCheck(binary: string, spec: PrereqSpec)` that runs `execa(binary, spec.versionArgs, {reject:false, timeout:5000})`, extracts the semver, calls `spec.isCompatible(version)`, and returns `spec.installHint(process.platform)` on MISSING / the incompatible hint on INCOMPATIBLE. Keep a thin `TokensavePrereqCheck` wrapper whose defaults come from the tokensave backend:
```ts
export class TokensavePrereqCheck {
  private readonly inner: GenericPrereqCheck;
  constructor(binary: string = new TokensaveBackend().processSpec().binary) {
    this.inner = new GenericPrereqCheck(binary, new TokensaveBackend().prereqSpec());
  }
  check() { return this.inner.check(); }
}
```
The `"tokensave"` default now resolves through `TokensaveBackend().processSpec().binary` — the literal lives only in the backend. `TOKENSAVE_VERSION_RANGE` and the install-hint strings MOVE to the backend (§2). The incompatible hint text (`tokensave ${detected} is incompatible; required range: ...`) may stay in the generic check as a format built from the range the spec knows — BUT the word "tokensave" in that string is engine-specific; safest is to have `installHint`/an `incompatibleHint(detected)` produced by the backend spec. Keep prereq.test.ts assertions satisfied: hint must `.toContain("5.4.0")` and `.toContain(">=6.0.0-beta.1 <7.0.0")` (prereq.test.ts:57-58).

**Imported by:** `pipeline-lifecycle.ts:21/78`, `cli/graph.ts:44/77/157/234`, `cli/impact.ts:102`, `cli/onboard.ts:71` — all keep the `new TokensavePrereqCheck(binary?)` signature → **unchanged**.

**Test file:** `tests/graph/prereq.test.ts` (exists).

---

### src/graph/cli.ts (modify)

`TokensaveCli` (lines 26-175) + private `parseSyncOutput` (187-220). Refactor to drive init/sync/status args + parsers from the backend's `CliMap`, while **keeping the class name + constructor signature** `(cwd, store?, binary?)` so `tests/graph/cli.test.ts` stays green with zero edits.

**Preserve EXACTLY (byte-identical behavior — evaluator checks these):**
- `init`: idempotent — `if (/already initialized/i.test(output)) return;` (line 59); `languageTier` accepted but NOT forwarded to argv (lines 36-39, 45).
- `sync`: `execa(binary, ["sync", ...paths], {cwd, timeout: timeoutMs, reject:false, all:true})`; timeout via `result.timedOut` (lines 84-88); parse `result.all ?? result.stdout` (line 99); manifest write via `this.store` (lines 103-116).
- `status`: `execa(binary, ["status","--json"], {cwd, reject:false, all:true})`; throw only on `result.failed && result.exitCode === null` (136-140); empty stdout → `{ready:false, indexedFileCount:0, tokensaveVersion:""}` (144-146); JSON parse deriving `fileCount` from `file_count`/`indexedFileCount`, `ready` from `parsed.ready===true || typeof file_count==="number" || typeof node_count==="number"` (154-169); unparseable → not-ready (170-172).
- `parseSyncOutput` ALL cases (187-220): ANSI-strip `/\x1b\[[0-9;?]*[a-zA-Z]/g` (line 190) with the `eslint-disable-next-line no-control-regex` comment; legacy JSON `{indexed:N}`; incremental `N added` + `M modified` summed; full re-index `N files`; legacy `indexed: N`.

**Recommended:** the class stays but reads args/parsers from `new TokensaveBackend().cliMap()` (built once in the constructor). `init` → `execa(binary, cliMap.initArgs(opts), ...)`, `sync` → `execa(binary, cliMap.syncArgs(paths), ...)` then `cliMap.parseSync(combined)`, `status` → `execa(binary, cliMap.statusArgs, ...)` then `cliMap.parseStatus(stdout)` (with the empty/throw guards staying in the class, since they are transport-level not parse-level). Move `parseSyncOutput` + the status-JSON body into the backend (§tokensave-backend). The argv the mock sees (`["init"]`, `["sync","src/","tests/"]`, `["status","--json"]`) stays identical → cli.test.ts green.

**Imported by:** `pipeline-lifecycle.ts:29/106`, `cli/graph.ts:90/170/244`, `hook-handler.ts:5/45` (type-only) — all keep `new TokensaveCli(cwd, store?, binary?)` → **unchanged**.

**Test file:** `tests/graph/cli.test.ts` (exists).

---

### src/graph/pipeline-lifecycle.ts (modify — construction site)

Constructs all three helpers. Only the `TokensaveMcpClient` construction (lines 96-101) changes its 4th arg; the prereq (78-80) and cli (106-110) constructions are **unchanged** (their class signatures are preserved). Already imports + constructs `TokensaveBackend` at line 27/250 — reuse ONE instance for both the transport and the GraphClient.

```ts
// CURRENT (96-101):
this.mcpClient = new TokensaveMcpClient(projectRoot, cfg, this.incidents, cfg.tokensavePath ?? "tokensave");
// RECOMMENDED:
const backend = new TokensaveBackend();
this.mcpClient = new TokensaveMcpClient(projectRoot, cfg, this.incidents, backend.processSpec());
// ... and pass the same `backend` into new GraphClient(...) at line 250.
```
The `cfg.tokensavePath ?? "tokensave"` override moved INTO the transport (`cfg.tokensavePath ?? processSpec.binary`), so the call site drops `?? "tokensave"`.

**Test file:** `tests/graph/pipeline-lifecycle.test.ts` (exists — must stay green).

---

## 2. Verbatim Strings — MOVE, do not paraphrase

These are marked "verbatim / DO NOT paraphrase" in the source. Copy them **character-for-character** into `tokensave-backend.ts`. The evaluator diffs them.

### Version range — `src/graph/prereq.ts:5`
```ts
export const TOKENSAVE_VERSION_RANGE = ">=6.0.0-beta.1 <7.0.0";
```

### semver check — `src/graph/prereq.ts:34-38`
```ts
semver.satisfies(version, TOKENSAVE_VERSION_RANGE, {
  includePrerelease: true,
})
```

### Version-string regex — `src/graph/prereq.ts:24-25`
```ts
// Accept "tokensave 6.0.0-beta.1" or "6.0.0-beta.1"
const match = firstLine.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/);
```

### Per-platform install hints — `src/graph/prereq.ts:48-58` (VERBATIM)
```ts
switch (process.platform) {
  case "darwin":
    return "brew install aovestdipaperino/tap/tokensave";
  case "win32":
    return "scoop bucket add tokensave https://github.com/aovestdipaperino/scoop-bucket && scoop install tokensave";
  default:
    return "cargo install tokensave";
}
```

### Incompatible hint — `src/graph/prereq.ts:60-63` (VERBATIM)
```ts
private incompatibleHint(detected: string): string {
  return `tokensave ${detected} is incompatible; required range: ${TOKENSAVE_VERSION_RANGE}`;
}
```

### parseSyncOutput ANSI strip + cases — `src/graph/cli.ts:190-217` (VERBATIM regexes)
```ts
// eslint-disable-next-line no-control-regex
const trimmed = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").trim();
// ... JSON {indexed:N} ...
const added = /(\d+)\s+added/.exec(trimmed);
const modified = /(\d+)\s+modified/.exec(trimmed);   // returns added + modified
const files = /(\d+)\s+files\b/.exec(trimmed);       // full re-index "N files"
const match = /indexed["\s:]+(\d+)/.exec(trimmed);   // legacy "indexed: 42"
```

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `TokensaveBackend` | `src/graph/backends/tokensave-backend.ts:119` | `class implements GraphBackend` | The one place engine strings/specs live. ADD the 3 accessors here; construct it at the 4 mcp sites. |
| `parseSyncOutput` | `src/graph/cli.ts:187` | `(output: string): number` | MOVE into the backend as `cliMap().parseSync`; do not re-implement. |
| `TOKENSAVE_VERSION_RANGE` | `src/graph/prereq.ts:5` | `const string` | MOVE into the backend; only referenced inside prereq.ts today (verified). |
| `assertNever` | `src/graph/types.ts:133` | `(x: never): never` | Exhaustive-switch guard (already used in backend line 190). |
| `StatusResult` / `SyncResult` | `src/graph/cli.ts:6-14` | `interface` | MOVE to `src/graph/types.ts`; re-export from cli.ts. Only used inside cli.ts (verified). |
| `semver.satisfies` / `semver.valid` | `semver` (dep) | `(v, range, opts)` | Version gating. Reuse; do NOT hand-roll comparison. |
| `execa` | `execa` (dep) | `(file, args, opts)` | The ONLY subprocess spawner. All three helpers + transport use it. |
| `logger` | `src/utils/logger.ts` | `.debug/.info/.warn` | Structured logging (used in mcp-client stderr routing). |
| `GraphArtifactStore` | `src/graph/artifact-store.ts` | `class` | Manifest read/write; injected into `TokensaveCli` for post-sync manifest update. |

**Utilities reviewed:** `src/utils/` (fs.ts, logger.ts, git.ts), `src/graph/*`, `src/graph/backends/*` — the graph-layer helpers above are the relevant ones; no new util is needed for this sprint.

---

## 4. Prior Sprint Output

### Sprint 1 (ae1bde7): GraphBackend seam
**Created:** `src/graph/backends/types.ts` — exports `GraphBackend`, `CallPlan<T>`, `QueryPattern`, `SearchOpts`. `src/graph/backends/tokensave-backend.ts` — exports `class TokensaveBackend implements GraphBackend` (tokensave_* tool catalog + narrow() adapters).
**Also:** `GraphClient` (`src/graph/client.ts:34`) now takes the backend as its 7th constructor arg (line 47) and delegates `{tool, params, narrow}` (e.g. `search` at lines 65-69). `client.ts` re-exports `QueryPattern`/`SearchOpts` for back-compat (line 32).
**Connection to this sprint:** You EXTEND the SAME `GraphBackend` interface (add `processSpec`/`prereqSpec`/`cliMap`) and the SAME `TokensaveBackend` class (implement them). The `{tool,params,narrow}` members are untouched. All 4 GraphClient construction sites already build `new TokensaveBackend()` (pipeline-lifecycle:250, mcp/server:109, impact:146, onboard:115) — reuse those instances for the transport too.

---

## 5. Relevant Documentation

### Project Principles (`.bober/principles.md`)
- **ESM everywhere:** all imports use `.js` extensions (NodeNext). Add `import type { ProcessSpec } from "./backends/types.js"`.
- **`import type`** for type-only imports (`consistent-type-imports` is ERRORED). ProcessSpec/PrereqSpec/CliMap/StatusResult imports must be `import type`.
- **Section comments:** `// ── Section Name ──` box headers (already used throughout these files).
- **TS strict + zero lint/type errors is a hard gate.** `noUnusedLocals`/`noUnusedParameters` on — prefix unused params with `_` (see the `_opts` in `initArgs`, mirroring cli.ts:41 where `opts` is intentionally not forwarded).
- **Conventional commit:** `bober(sprint-2): ...` (contract generatorNotes gives the exact message).

### Architecture Decisions
- `arch-20260524-...` ADR series covers the graph port. No ADR specifically for this pluggable-backend refactor. The `execa(..., argv-array, ...)` "spawn without shell" is annotated **ADR-10** at `mcp-client.ts:241` — preserve the argv-array form (never a shell string).
- **No spec/arch doc for `spec-20260726-graph-backend-choice`** was found under `.bober/architecture/`. The contract's assumptions/generatorNotes are authoritative.

### Other Docs
- CLAUDE.md / CONTRIBUTING.md: none in repo root beyond principles.md.

---

## 6. Testing Patterns

**Runner:** Vitest. **Assertion:** `expect(...)`. **Mock approach:** `vi.mock("execa", () => ({ execa: vi.fn() }))` at top of file. **File naming:** `*.test.ts`. **Location:** `tests/graph/` (not co-located for the graph layer).

### Pattern A — mock execa result (unit) — `tests/graph/cli.test.ts:15-25`
```ts
vi.mock("execa", () => ({ execa: vi.fn() }));
import { execa } from "execa";
function mockExeca(value: Record<string, unknown>): void {
  (execa as unknown as Mock).mockResolvedValue({
    exitCode: 0, stdout: "", stderr: "", failed: false, timedOut: false, all: "", ...value,
  });
}
```
Assert argv with `expect(execa).toHaveBeenCalledWith("tokensave", ["sync","src/","tests/"], expect.objectContaining({ timeout: 3_000 }))` (cli.test.ts:169-173). **These assertions must still pass** — the CliMap must emit identical argv.

### Pattern B — prereq mocked-version (unit) — `tests/graph/prereq.test.ts:14-24, 46-60`
```ts
(execa as unknown as Mock).mockResolvedValue({ exitCode: 0, stdout: "tokensave 6.0.0-beta.1", failed: false });
const { TokensavePrereqCheck } = await import("../../src/graph/prereq.js");
const r = await new TokensavePrereqCheck().check();
expect(r.ok).toBe(true);
// INCOMPATIBLE: stdout "tokensave 5.4.0" → r.hint.toContain("5.4.0") && .toContain(">=6.0.0-beta.1 <7.0.0")
```
**For sc-2-3 add:** a `"tokensave 6.1.1"` → ok case; and a backend-level test `backend.prereqSpec().isCompatible("6.1.1") === true`, `isCompatible("5.9.0") === false`, and `installHint("darwin"/"win32"/"linux")` returning the three verbatim strings.

### Pattern C — fake subprocess for the transport — `tests/graph/mcp-client.test.ts:61-113`
`makeFakeSubprocess()` returns a stdin/stdout/stderr `PassThrough` fake; `(execa).mockReturnValueOnce(subprocess)`. Handshake is driven by finding the `"initialize"` write and pushing a correlated response. **Because execa is mocked, `processSpec.serveArgs` does not affect the fake** — but the constructor now REQUIRES a 4th arg, so update all constructions (see §7).
**For sc-2-2 add:** after `start()` with the vi.fn execa mock, assert `(execa as Mock).mock.calls[0][0]` === `"tokensave"` and `(execa as Mock).mock.calls[0][1]` `toEqual(["serve"])`.

### Pattern D — backend pure-adapter test — `tests/graph/backends/tokensave-backend.test.ts:7-9`
```ts
const backend = new TokensaveBackend();
it("has id 'tokensave'", () => { expect(backend.id).toBe("tokensave"); });
```
No mocks needed — pure. **Add for sc-2-2/2-3/2-4:**
```ts
expect(backend.processSpec()).toEqual({ binary: "tokensave", serveArgs: ["serve"] });
expect(backend.cliMap().parseSync("3 added, 1 modified, 0 removed")).toBe(4);   // sc-2-4
expect(backend.prereqSpec().isCompatible("6.1.1")).toBe(true);                  // sc-2-3
expect(backend.prereqSpec().isCompatible("5.9.0")).toBe(false);
```

### Integration (skipIf real binary) — `tests/graph/mcp-client.test.ts:678-803`
`const tokensaveAvailable = hasTokensave()` (spawnSync probe, 21-30); `it.skipIf(!tokensaveAvailable)(...)`. These construct with a 4th positional `"tokensave"` (lines 697, 719, 745, 780) and, in the integration `beforeEach` (682-685), restore the real execa. **You MUST update those 4 constructions** from `"tokensave"` to `new TokensaveBackend().processSpec()` (import `TokensaveBackend` at the top of the test). They assert: start `<2s` + `health()==="ready"` (688-707); `call("tokensave_status", {})` returns an object with numeric `db_size_bytes` (709-734).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `tests/graph/mcp-client.test.ts` | `TokensaveMcpClient` 4th ctor arg | **high** | ~12 constructions pass 3 args (rely on the removed `="tokensave"` default) or 4th arg `"tokensave"`. Update ALL to pass a `ProcessSpec`. |
| `src/graph/pipeline-lifecycle.ts:96` | `TokensaveMcpClient` ctor | medium | Pass `backend.processSpec()`; reuse the backend already built at :250. |
| `src/mcp/server.ts:95` | `TokensaveMcpClient` ctor (dynamic import) | medium | Already imports `TokensaveBackend` at :89 → pass `.processSpec()`. |
| `src/cli/commands/impact.ts:119` | `TokensaveMcpClient` ctor | medium | Already builds `TokensaveBackend` at :146 → reuse. |
| `src/cli/commands/onboard.ts:88` | `TokensaveMcpClient` ctor | medium | Already builds `TokensaveBackend` at :115 → reuse. |
| `src/graph/backends/types.ts` consumers | `GraphBackend` interface | low | Additive members only; `TokensaveBackend` must implement all 3 or `tsc` fails (this is the sc-2-1 gate). |
| `src/graph/cli.ts` (StatusResult/SyncResult move) | type location | low | Add re-export `export type { SyncResult, StatusResult } from "./types.js";` so no importer breaks. |
| prereq/cli construction sites (7 + 4) | class signatures preserved | low | UNCHANGED — verify by grep after the edit. |

### Existing Tests That Must Still Pass (no NEW failures)
- `tests/graph/mcp-client.test.ts` — breaker math, PendingMap correlation, handshake, envelope/unwrap (sc-1-2..1-5), + skipIf integration. Affected because the ctor arg changed → update constructions; behavior identical.
- `tests/graph/prereq.test.ts` — compatible/MISSING/INCOMPATIBLE + 3 platform-hint assertions (exact strings). Must pass UNCHANGED (verifies the verbatim strings survived the move).
- `tests/graph/cli.test.ts` — init idempotent, sync 42/743/legacy-JSON/empty/timeout/argv, status shapes. Must pass UNCHANGED (verifies CliMap emits identical argv + parses identically).
- `tests/graph/backends/tokensave-backend.test.ts` — existing narrow() tests; you EXTEND it.
- `tests/graph/pipeline-lifecycle.test.ts`, `tests/graph/client.test.ts`, `tests/graph/hook-handler.test.ts` — exercise the constructed helpers; must stay green.

### Features That Could Be Affected
- **Sprint 3 (config.graph.backend + auto-detection)** — builds directly on these specs. Keep the accessor names/shapes as in generatorNotes so Sprint 3 can select a backend and pass its specs uniformly.
- **`agent-bober graph`/`impact`/`onboard`/`mcp` commands** — all spawn tokensave via these helpers; behavior must be byte-identical.

### Recommended Regression Checks (run after implementation)
1. `npm run build && npm run typecheck` → zero errors (sc-2-1). `tsc` proves `TokensaveBackend` implements all 3 new accessors.
2. `npx vitest run tests/graph/` → all green (mcp-client, prereq, cli, backends, client, pipeline-lifecycle, hook-handler).
3. `npx vitest run` (full suite) → no NEW failures (sc-2-6).
4. `npm run lint` → zero errors (sc-2-7). Watch `consistent-type-imports` on the new type imports and the `no-control-regex` disable-comment survival.
5. If `tokensave` on PATH: the 4 skipIf integration tests pass (handshake `<2s`, `tokensave_status` round-trip returns numeric `db_size_bytes`).
6. Leak audit: `grep -rn "serve\"\|\"tokensave\"\|6.0.0-beta.1\|brew install\|cargo install\|scoop bucket" src/graph/mcp-client.ts src/graph/prereq.ts src/graph/cli.ts` → should return NOTHING (all literals moved to `tokensave-backend.ts`).

---

## Design Recommendation (satisfies sc-2-5 at lowest churn)

**Keep the class names `TokensaveMcpClient`, `TokensavePrereqCheck`, `TokensaveCli`.** Contract assumption #5 explicitly permits keeping `TokensaveMcpClient`; a generic rename is an optional follow-up. What sc-2-5 requires is that the `'tokensave'` default binary and the `['serve']` literal no longer live in the transport where another engine can't override them.

- **Transport:** inject a `ProcessSpec` (swap the `binary: string = "tokensave"` ctor param for `processSpec: ProcessSpec`, no default). Resolve `cfg.tokensavePath ?? processSpec.binary`, spawn `processSpec.serveArgs`. This is the ONLY signature change → only the 4 mcp construction sites + the mcp-client tests move. Alternative (passing the whole `GraphBackend`) also works and is symmetric with GraphClient, but couples the transport to the full backend interface — the `ProcessSpec` injection is the minimal, contract-worded option.
- **Prereq + CLI:** KEEP their constructor signatures `(binary?)` and `(cwd, store?, binary?)`; internally build the spec/cliMap from `new TokensaveBackend()`. This keeps all 7 prereq + 4 cli construction sites AND `prereq.test.ts` + `cli.test.ts` **unchanged** — the churn is confined to moving the strings/parsers into the backend and re-wiring the class internals.

This confines the diff to `backends/*`, `mcp-client.ts`, `prereq.ts`, `cli.ts` + their tests + the 4 mcp construction sites — exactly the boundary sc-2-7 requires.

---

## 8. Implementation Sequence

1. **`src/graph/types.ts`** — move `SyncResult` + `StatusResult` here (from cli.ts:6-14).
   - Verify: `tsc` still resolves; add the types before anything imports them.
2. **`src/graph/backends/types.ts`** — add `ProcessSpec`, `PrereqSpec`, `CliMap` types + `processSpec()`/`prereqSpec()`/`cliMap()` on `GraphBackend`; `import type { StatusResult } from "../types.js"`.
   - Verify: interface compiles; `TokensaveBackend` now shows a type error for the 3 missing members (expected until step 3).
3. **`src/graph/backends/tokensave-backend.ts`** — implement the 3 accessors; MOVE `TOKENSAVE_VERSION_RANGE`, the brew/scoop/cargo + incompatible hints, `parseSyncOutput`, and the status-JSON parsing here (verbatim, §2). Add `import semver from "semver"`.
   - Verify: `npx vitest run tests/graph/backends/` green; the class type error from step 2 clears.
4. **`src/graph/mcp-client.ts`** — swap ctor param → `processSpec: ProcessSpec`; spawn `cfg.tokensavePath ?? processSpec.binary` + `processSpec.serveArgs`.
   - Verify: leak-grep (regression check #6) returns nothing for mcp-client.ts.
5. **`src/graph/prereq.ts`** — extract `GenericPrereqCheck(binary, spec)`; make `TokensavePrereqCheck` a wrapper over the backend's `prereqSpec()`. Remove the moved strings/range.
   - Verify: `npx vitest run tests/graph/prereq.test.ts` green UNCHANGED.
6. **`src/graph/cli.ts`** — drive init/sync/status argv + parsers from `cliMap()`; keep the transport-level guards (idempotent-init, timeout, empty-stdout, throw-on-null-exit) in the class. Re-export `SyncResult`/`StatusResult`.
   - Verify: `npx vitest run tests/graph/cli.test.ts` green UNCHANGED (argv + parse assertions).
7. **Construction sites** — update the 4 `new TokensaveMcpClient(...)` calls (pipeline-lifecycle:96, mcp/server:95, impact:119, onboard:88) to pass `backend.processSpec()`, reusing the `TokensaveBackend` instance already built for the GraphClient. Prereq + CLI sites unchanged.
   - Verify: `grep -rn "new TokensaveMcpClient" src/` — every call now passes a spec, none passes `"tokensave"`.
8. **Tests** — update ~12 `TokensaveMcpClient` constructions in `mcp-client.test.ts` (add `import { TokensaveBackend }`, pass `new TokensaveBackend().processSpec()` incl. the 4 skipIf integration ones); add the sc-2-2 spawn-argv assertion; add sc-2-2/2-3/2-4 assertions to `tokensave-backend.test.ts`.
   - Verify: `npx vitest run tests/graph/mcp-client.test.ts tests/graph/backends/` green.
9. **Full verification** — `npm run build && npm run typecheck && npx vitest run && npm run lint`; if tokensave present, confirm the skipIf integration tests ran and passed. Commit: `bober(sprint-2): fold process/prereq/cli specs into GraphBackend; transport spawns from ProcessSpec`.

---

## 9. Pitfalls & Warnings

- **Verbatim strings.** The install hints, version range, and incompatible-hint format are evaluator-diffed character-for-character (§2). Copy, don't retype from memory. The scoop hint is a long string with `&&` — copy the whole line.
- **`includePrerelease: true`** must survive on the `semver.satisfies` call — without it, `6.0.0-beta.1` fails its own range and `prereq.test.ts:21-23` breaks.
- **The `no-control-regex` eslint-disable comment** (cli.ts:189) must move WITH the ANSI-strip regex into the backend, or lint fails on the `\x1b` control char.
- **Do NOT forward `languageTier` to argv.** `init` is `["init"]` only (cli.ts:36-39). cli.test.ts:52-56 asserts `["init"]` exactly and :84-89 asserts the languageTier does not appear.
- **`status` guards stay in the class, not the parser.** The throw-on-`exitCode===null` (136-140), empty-stdout early return (144-146), and try/catch-to-not-ready (170-172) are transport concerns. Only the JSON→StatusResult body (154-169) moves to `cliMap().parseStatus`. If you move the empty/throw guards into the parser you change behavior (status must not throw on non-zero exit).
- **Constructor arity break is silent-ish.** Removing the `="tokensave"` default makes the 4th arg required; TS will flag the call sites, but the ~12 test constructions that passed only 3 args will ALSO error — update them all or the graph test file won't compile.
- **Reuse ONE `TokensaveBackend` instance** per construction site (transport + GraphClient) — do not build two; it's cheap but keeping one is cleaner and future-proofs Sprint 3's single-selection point.
- **Circular type import.** If you leave `StatusResult` in `cli.ts` and import it into `backends/types.ts`, and `cli.ts` imports `CliMap` from `backends/types.ts`, you get a type-only cycle. Move `StatusResult`/`SyncResult` to `graph/types.ts` to avoid it (they have no external importers — verified).
- **nonGoals — do not touch:** breaker math/window, health state machine, PID/orphan handling, the MCP `initialize`/`tools/call` wire protocol, GraphClient public signatures, shared types. Do NOT add `config.graph.backend`, auto-detection, or code-review-graph specs (those are Sprints 3-6).
