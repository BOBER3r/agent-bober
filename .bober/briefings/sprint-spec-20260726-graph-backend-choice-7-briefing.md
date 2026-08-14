# Sprint Briefing: Command parity (onboard/impact/graph/mcp) through resolved backend + `graph status` readout

**Contract:** sprint-spec-20260726-graph-backend-choice-7
**Generated:** 2026-07-27T00:00:00Z

> TL;DR for the Generator: **onboard, impact, graph, mcp/server ALL ALREADY resolve the backend** (`resolveGraphBackend` + `binaryForBackend` were wired in Sprint 3). This sprint is mostly (a) proving each surface EXERCISES cr-graph via new tests, (b) 4 small production edits, and (c) 3 folded-in follow-ups. The single most important production change is the **HIGH reviewContext fix**: route `GraphClient.reviewContext()` through `runWithSandbox` with the backend's narrow (exactly like `overview()`), NOT `runRaw`.

---

## 0. What already works vs. what to change (read this first)

| Surface | Already resolves backend? | Evidence | Sprint-7 change |
|---------|--------------------------|----------|-----------------|
| `onboard` | YES | `onboard.ts:72-73` `resolveGraphBackend` + `binaryForBackend`; passes `backend` to `GraphClient` at `:120` | ONE line: `:141` version source → `backendVersion`. (Optional MEDIUM: thread binary into mcpClient `:93`.) + new test |
| `impact` | YES | `impact.ts:103-104`; passes `backend` at `:151` | No prod change needed for sc-7-3 (already uses resolved backend). + new cr-graph test. (Optional MEDIUM binary thread at `:124`.) |
| `graph` (init/sync/status) | YES | `graph.ts:58-59, 95-96, 184-185, 268-269`; `TokensaveCli` built from resolved backend at `:114, :203, :284` | Augment existing `status` action (`:242-316`) with engine/version/selectedBy readout (sc-7-5) |
| `mcp/server.ts` | YES | `server.ts:95` `resolveGraphBackend`; passes `backend` to `GraphClient` at `:110` | No prod change needed for sc-7-4 (already resolved). + new test. (Optional MEDIUM binary thread at `:96`.) NOTE: `server.ts` does NOT currently call `binaryForBackend`. |

**None of the surfaces build a bare `TokensaveBackend`** — Sprint 3 already fixed that. So sc-7-2/3/4/6 are primarily *coverage* work. The real code deltas are: onboard `:141`, the reviewContext fix (`client.ts:91-94`), the `graph status` readout (`graph.ts:242-316`), and the OPTIONAL MEDIUM binary-threading at 3-4 construction sites.

---

## 1. Target Files

### src/cli/commands/onboard.ts (modify)

**Relevant section — version line (lines 135-143):**
```ts
        // Get manifest for status
        const manifest = await store.readManifest();

        // Build onboarding inputs from graph results
        const inputs: OnboardingInputs = {
          status: {
            tokensaveVersion: manifest?.tokensaveVersion ?? prereq.version ?? "",   // ← line 141: CHANGE
            indexedFileCount: manifest?.indexedFileCount ?? 0,
          },
```
**Change (sc-7-2):** line 141 → `tokensaveVersion: manifest?.backendVersion ?? prereq.version ?? "",`
- Keep the `OnboardingInputs.status` FIELD NAME `tokensaveVersion` (it is the type field at `src/graph/types.ts:122`; the nonGoal forbids reworking onboard's data strategy). Only the *source value* changes.
- **Byte-identical proof for tokensave:** `readManifest()` normalizes `backendVersion: raw.backendVersion ?? raw.tokensaveVersion ?? ""` (`artifact-store.ts:35`); and `graph.ts` init/sync always write `backendVersion: prereq.version` and (for tokensave) `tokensaveVersion: prereq.version` (`graph.ts:143-147, 222-226`). So on the tokensave path `manifest.backendVersion === manifest.tokensaveVersion` always → identical value.

**Already-resolved backend (lines 70-98):** `resolveGraphBackend(config)` (`:72`), `binaryForBackend(backend, config)` (`:73`), `new GenericPrereqCheck(binary, backend.prereqSpec())` (`:76`), `new TokensaveMcpClient(projectRoot, graphCfg, incidents, backend.processSpec())` (`:93-98`), `new GraphClient(..., graphCfg, backend)` (`:113-121`). No rewrite needed.

**Imports this file uses:** `resolveGraphBackend, binaryForBackend` from `../../graph/backends/registry.js` (`:22`); `TokensaveMcpClient` from `../../graph/mcp-client.js` (`:18`); `GraphClient` from `../../graph/client.js` (`:21`); `OnboardingComposer` (`:23`); `OnboardingInputs` type (`:24`).
**Test file:** `tests/cli/graph-commands.test.ts` (disabled-path only, `:128-147`). No cr-graph onboard test exists → create `tests/graph/onboard.test.ts` (in `estimatedFiles`).

---

### src/cli/commands/impact.ts (modify — optional / coverage only)

sc-7-3 needs a *test* forcing cr-graph; the code already resolves the backend (`:103-104`, GraphClient at `:144-152`). It calls `graphClient.impact(target)` and `graphClient.query("tests_for", targetRef)` (`:166-169`). Only touch this file if you apply the OPTIONAL MEDIUM binary-thread at `:124-129`.

**Construction site (lines 124-129):**
```ts
      const mcpClient = new TokensaveMcpClient(
        projectRoot,
        graphCfg,
        incidents,
        backend.processSpec(),   // ← MEDIUM: pass processSpecForBackend(backend, config) here
      );
```
**Test file:** none for cr-graph → add to `tests/graph/onboard.test.ts` or a sibling; assert `mcpClient.call` was invoked with cr-graph tools `get_impact_radius_tool` + `query_graph_tool` (NOT `tokensave_impact`).

---

### src/cli/commands/graph.ts (modify — sc-7-5 readout)

**Existing `status` subcommand (lines 242-316) — this is what you AUGMENT (do NOT add a new subcommand; the contract assumption explicitly allows augmenting the existing status output):**
```ts
  graph
    .command("status")
    .description("Show code graph status")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      ...
      const backend = await resolveGraphBackend(config);      // :268  (already present)
      const binary = binaryForBackend(backend, config);       // :269
      const prereq = await checker.check();                   // :273  (prereq.version = live version)
      ...
      const output = {
        ready: liveStatus.ready,
        indexedFileCount: ...,
        tokensaveVersion: liveStatus.tokensaveVersion || manifest?.tokensaveVersion || "",  // :295
        lastSyncedHeadSha: manifest?.lastSyncedHeadSha ?? null,
        stale: staleness.stale,
      };
      if (opts.json) { process.stdout.write(JSON.stringify(output, null, 2) + "\n"); return; }
      // Human-readable
      process.stdout.write(`Status:          ${readyStr}${staleStr}\n`);   // :308
      process.stdout.write(`Indexed files:   ${output.indexedFileCount}\n`);
      process.stdout.write(`Tokensave:       ${output.tokensaveVersion || chalk.gray("(unknown)")}\n`);  // :310-312
      process.stdout.write(`Last HEAD SHA:   ${output.lastSyncedHeadSha ?? chalk.gray("(none)")}\n`);
    });
```
**Change (sc-7-5):** Inside the `status` action you already have `backend`, `prereq`, `manifest`, and `config`. ADD (do not remove the existing lines — see Impact Analysis):
- `engine: backend.id`
- `backendVersion: prereq.version || manifest?.backendVersion || ""`
- `selectedBy: config.graph?.backend ? "config" : "auto-detect"`  ← minimal, computed at the call site (see §3-registry note)

Add these to the `output` object (JSON is additive/back-compat) AND add human lines, e.g.:
```ts
      process.stdout.write(`Engine:          ${output.engine}\n`);
      process.stdout.write(`Version:         ${output.backendVersion || chalk.gray("(unknown)")}\n`);
      process.stdout.write(`Selected by:     ${output.selectedBy}\n`);
```
**Rule:** ADD lines; do NOT change the existing `Status:/Indexed files:/Tokensave:/Last HEAD SHA:` lines (keeps tokensave stdout a superset → existing behavior byte-identical for the fields other code/tests read).

---

### src/mcp/server.ts (modify — optional / coverage only)

Already resolves the backend and passes it to `GraphClient`:
```ts
        const backend = await resolveGraphBackend(config);              // :95
        const mcpClient = new TokensaveMcpClient(
          projectRoot, cfg, incidents, backend.processSpec());          // :96-101  (← MEDIUM binary-thread here)
        const client = new GraphClient(projectRoot, mcpClient, store,
          graphFallback, incidents, cfg, backend);                      // :103-111
        registerGraphTools({ client, fallback: graphFallback });        // :112
```
The graph modules are loaded via dynamic `await import(...)` (`:84-90`) — so `vi.mock` on those module paths intercepts them in tests. `server.ts` does NOT import `binaryForBackend` yet; the MEDIUM fix would add it.
**Test file:** `tests/mcp/external-server-graph.test.ts` covers *tool registration* only (via `createGraphTools`), NOT `createBoberMCPServer` end-to-end. No `createBoberMCPServer` test exists (`grep createBoberMCPServer tests/` → none). Add the sc-7-4 test to `tests/mcp/external-server-graph.test.ts` or a new file.

---

### src/graph/client.ts (modify — HIGH follow-up)

**Current `reviewContext` (lines 91-94) + `runRaw` (216-218):**
```ts
  async reviewContext(nodes: NodeRef[]): Promise<GraphResult<string>> {
    const { tool, params } = this.backend.reviewContextPlan(nodes);   // ← discards `narrow`
    return this.runRaw<string>(tool, params);                          // ← identity cast, bypasses narrow
  }
  ...
  private async runRaw<T>(tool: string, params: unknown): Promise<GraphResult<T>> {
    return this.runWithSandbox<T>(tool, params, (raw) => raw as T);     // (raw) => raw as T  ← identity
  }
```
**Compare with the correct pattern — `overview()` (lines 96-99):**
```ts
  async overview(): Promise<GraphResult<string>> {
    const { tool, params, narrow } = this.backend.overviewPlan();
    return this.runWithSandbox<string>(tool, params, narrow);          // ← applies the backend narrow
  }
```
**RECOMMENDED FIX (lowest-risk — mirror `overview()`):**
```ts
  async reviewContext(nodes: NodeRef[]): Promise<GraphResult<string>> {
    const { tool, params, narrow } = this.backend.reviewContextPlan(nodes);
    return this.runWithSandbox<string>(tool, params, narrow);
  }
```
- Prefer this over "give `runRaw` an optional narrow param" — routing through `runWithSandbox` with the plan's narrow is the *exact existing pattern* used by `overview()`, needs no signature change, and `runWithSandbox` applies NO `keepNode`/NodeRef filtering of its own (keepNode lives only inside the search/query/impact/changes closures), so a string result is unaffected.
- `runRaw` becomes unused after this change — either delete it or leave it (it is `private`; if unused, TS/lint may flag `no-unused` → safest to DELETE `runRaw` at `:215-218` since `reviewContext` was its only caller — verify with `grep -n runRaw src/`).

**Why the bug matters (cr-graph):** `code-review-graph-backend.ts:254-263` `reviewContextPlan.narrow = (raw) => (typeof raw === "string" ? raw : JSON.stringify(raw))`. `get_review_context_tool` returns a JSON OBJECT (see fixture `tests/graph/fixtures/cr-graph/get_review_context_tool.json` — top-level `{status, summary, context:{...}}`), which `unwrapMcpContent` JSON.parses into an object (`mcp-client.ts:80-101`). Without the narrow, `reviewContext()` returns that object mistyped as `GraphResult<string>`.

**Byte-identical proof for tokensave:** `tokensave-backend.ts:310-317` `reviewContextPlan.narrow = (raw) => raw as string` — a pure identity cast, IDENTICAL to `runRaw`'s `(raw) => raw as T`. tokensave_context returns plain markdown text (not JSON), so `unwrapMcpContent` returns the raw string verbatim; narrow and runRaw produce the SAME string. The existing tokensave test `tests/graph/client.test.ts:312-320` (asserts `r.data` contains "Code Context") passes UNCHANGED.

---

## 2. Patterns to Follow

### Backend-forcing CLI test (SpyCli records constructor args)
**Source:** `tests/cli/graph-commands-backend.test.ts:26-100, 140-167`
```ts
vi.mock("execa", () => ({ execa: vi.fn() }));
vi.mock("../../src/utils/fs.js", () => ({ findProjectRoot: vi.fn().mockResolvedValue("/fake/project"), fileExists: vi.fn().mockResolvedValue(false), ensureDir: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/graph/prereq.js", () => ({ GenericPrereqCheck: vi.fn().mockImplementation(() => ({ check: vi.fn().mockResolvedValue({ ok: true, version: "1.0.0" }) })) }));
vi.mock("../../src/graph/artifact-store.js", () => ({ GraphArtifactStore: vi.fn().mockImplementation(() => ({ ensureLayout: vi.fn().mockResolvedValue(undefined), readManifest: vi.fn().mockResolvedValue(null), writeManifest: vi.fn().mockResolvedValue(undefined), staleness: vi.fn().mockResolvedValue({ stale: false }) })) }));
vi.mock("../../src/config/loader.js", () => ({ loadConfig: vi.fn() }));
function crGraphConfig() { return { graph: { enabled: true, backend: "code-review-graph", languageTier: "core", manifestPath: ".bober/graph/manifest.json", syncTimeoutMs: 2_000 } }; }
```
**Rule:** REAL `resolveGraphBackend` + REAL backends; with `graph.backend` explicit, the resolver short-circuits with NO probe (`registry.ts:102-111`) → deterministic, no filesystem/PATH. Use this exact mock stack for the `graph status` readout test (sc-7-5) and the impact test (sc-7-3).

### Transport-mock via mocked GraphClient / mcp-client
**Source:** `tests/graph/client.test.ts:27-38` (mock mcp), `:692-705` (cr-graph client factory)
```ts
function makeMockMcp(opts = {}) {
  return { call: vi.fn().mockImplementation(opts.callImpl ?? (async () => [])),
           health: vi.fn().mockReturnValue(opts.health ?? "ready"),
           start: vi.fn(), stop: vi.fn(), childPid: 12345 } as unknown as TokensaveMcpClient;
}
function makeCrClient(projectRoot, callImpl) {
  return new GraphClient(projectRoot, makeMockMcp({ callImpl }), makeMockStore(false),
    new GraphFallback("dual"), makeMockIncidents(), makeConfig(), new CodeReviewGraphBackend());
}
```
**Rule:** For onboard/impact CLI tests, `vi.mock("../../src/graph/mcp-client.js")` so the internally-constructed `TokensaveMcpClient` is a stub whose `.call(tool, params)` switches on `tool` and returns the matching cr-graph fixture. Set `projectRoot="/repo"` so the fixture nodes (`/repo/src/...`) survive `keepNode` sandbox filtering (`client.test.ts:708-730` demonstrates the /repo requirement).

### Fixture loader
**Source:** `tests/graph/backends/code-review-graph-backend.test.ts:23-28`
```ts
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/cr-graph");
async function loadFixture(name) { return JSON.parse(await readFile(join(FIXTURES_DIR, name), "utf-8")); }
```
**Rule:** Reuse the 5 search calls with `semantic_search_nodes_tool.json` for onboard; `get_impact_radius_tool.json` + `query_graph_tests_for_tool.json` for impact; `get_review_context_tool.json` for the reviewContext e2e.

### Stdio capture
**Source:** `tests/cli/graph-commands-backend.test.ts:104-127` (`captureStdio` → `{stdout, stderr, restore}` spying `process.stdout.write`). Use for asserting the `graph status` readout lines and onboard's "5 files written".

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `resolveGraphBackend` | `src/graph/backends/registry.ts:95` | `(config, deps?) => Promise<GraphBackend>` | Picks engine: explicit `config.graph.backend` wins (no probe), else auto-detect (tokensave-first) |
| `binaryForBackend` | `src/graph/backends/registry.ts:70` | `(backend, config) => string` | Per-backend binary honoring `tokensavePath` / `codeReviewGraphPath` overrides |
| `KNOWN_BACKENDS` | `src/graph/backends/registry.ts:28` | `readonly GraphBackend[]` | `[TokensaveBackend, CodeReviewGraphBackend]` in preference order |
| `GraphArtifactStore.readManifest` | `src/graph/artifact-store.ts:24` | `() => Promise<GraphManifest \| null>` | Reads + normalizes manifest; injects `backend`/`backendVersion` for legacy files (`:32-36`) |
| `GraphClient.reviewContext` / `overview` / `impact` / `search` / `query` | `src/graph/client.ts:91,96,79,65,72` | `... => Promise<GraphResult<T>>` | Typed graph facade; delegates tool/params/narrow to injected backend |
| `GraphClient.runWithSandbox` (private) | `src/graph/client.ts:178` | `(tool, params, narrow) => Promise<GraphResult<T>>` | The chokepoint the reviewContext fix must route through |
| `GenericPrereqCheck` | `src/graph/prereq.js` (imported `onboard.ts:16`) | `new (binary, prereqSpec).check() => Promise<PrereqResult>` | Version-gate probe; `prereq.version` = live engine version |
| `OnboardingComposer.render` / `writeAll` | `src/graph/onboarding-composer.js` (`onboard.ts:195-201`) | `render(inputs) => artifacts`; `writeAll(artifacts, dir)` | Renders + writes the 5 markdown artifacts (all 5 always written, even with empty inputs) |
| `TokensaveMcpClient` | `src/graph/mcp-client.ts:105` | `new (root, cfg, incidents, processSpec)` | Long-lived serve subprocess; `.call/.start/.stop/.health` |
| `CodeReviewGraphBackend` | `src/graph/backends/code-review-graph-backend.ts:161` | class impl `GraphBackend` | cr-graph tool catalog + narrows (all 6 plans real as of Sprint 6) |

**Utilities reviewed:** `src/graph/backends/registry.ts`, `src/graph/artifact-store.ts`, `src/graph/client.ts`, `src/graph/mcp-client.ts`, both backends, `src/graph/prereq.js`, `src/graph/onboarding-composer.js`. No new util needed.

**`selectedBy` — minimal addition:** `resolveGraphBackend` does NOT return HOW it selected (it returns only the `GraphBackend`). Do NOT change its signature (all 5 call sites + `tests/graph/backends/registry.test.ts` depend on it). Instead compute at the `graph status` call site: `const selectedBy = config.graph?.backend ? "config" : "auto-detect";` — this exactly mirrors the resolver's own `explicit = config.graph?.backend` branch (`registry.ts:100-103`). If you want it DRY/testable, add an ADDITIVE exported helper `graphBackendSelectionSource(config): "config" | "auto-detect"` in `registry.ts` (does not touch `resolveGraphBackend`). Inline is the truly minimal option.

---

## 4. Prior Sprint Output

### Sprint 3: backend selection + manifest backend/backendVersion (77bb53c+6fc5a00)
**Created/wired:** `resolveGraphBackend`, `binaryForBackend` into ALL 5 construction sites (onboard, impact, graph, mcp/server, pipeline-lifecycle). `GraphManifest.backend`/`backendVersion` fields (`types.ts:17-20`); `readManifest` normalization (`artifact-store.ts:32-36`).
**Connection:** Sprint 7 relies on this — the surfaces already resolve; you prove they *exercise* cr-graph + source onboard's version from `backendVersion`.

### Sprint 4: cr-graph CLI map + fixtures (ed7d9cf)
**Created:** `CodeReviewGraphBackend.cliMap()` (init→build, sync→update, status→status --json); fixtures under `tests/graph/fixtures/cr-graph/`.
**Connection:** `graph.ts` cr-graph CLI parity is ALREADY tested (`graph-commands-backend.test.ts`). Reuse the fixtures.

### Sprint 5: cr-graph read adapters (2ebe2af)
**Created:** search/impact/reviewContext/overview/changes narrows. **Left the reviewContext narrow-bypass gap** (`code-review-graph-backend.ts:257-258` comment) — the HIGH follow-up.
**Connection:** The reviewContext fix closes this gap; update `client.test.ts:744-753`.

### Sprint 6: cr-graph query sub-patterns (4b837ff)
**Created:** `queryPlan` 4 sub-patterns via `query_graph_tool`; `imports_of`→`importers_of` direction trap (`code-review-graph-backend.ts:150-155`).
**Connection:** impact test's `tests_for` uses `query_graph_tool`.

---

## 5. Relevant Documentation

### Project Principles (from handoff)
TypeScript strict, ESM `.js` imports, `import type`, no `any`, no sync fs, conventional commits. **Never main.** Baseline: **5076 passed / 2 skipped / 0 failures.** Commit BEFORE final response. **Tokensave path MUST stay byte-identical** (existing onboard/impact/graph/reviewContext tests pass unchanged). Do NOT rework onboard's search()-based data strategy (nonGoal).

### Architecture Decisions
`.bober/architecture/arch-20260524-port-code-review-graph-architecture.md` (referenced by every CLI as `ARCH_DOC_PATH`). ADR-3: GraphClient methods NEVER throw for expected failures, callers branch on `.ok` (`client.ts:1-9`). Backend seam: backend owns tool/params/narrow, GraphClient owns sandbox/staleness/health (`backends/types.ts:54-95`). No separate principles.md read was required — principles are inlined in the handoff.

### Config schema (relevant fields)
`src/config/schema.ts`: `graph.backend` `z.enum(["tokensave","code-review-graph"]).optional()` (`:398`); `graph.codeReviewGraphPath` optional (`:400`); `graph.tokensavePath` optional (`:396`); `graph.exposeOnExternalMcp` default true (`:412`).

---

## 6. Testing Patterns

### Unit Test Pattern
**Source:** `tests/cli/graph-commands-backend.test.ts` (full stack above) + `tests/graph/client.test.ts:27-88`
**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** `vi.mock(modulePath, factory)` (static, hoisted) + `vi.fn()`; `execa` mocked at top. **File naming:** `*.test.ts`. **Location:** `tests/` mirroring `src/` (`tests/graph/`, `tests/cli/`, `tests/mcp/`).

### reviewContext e2e — the Sprint-5 gap to CLOSE (sc-7 HIGH)
**Source (current, MUST UPDATE):** `tests/graph/client.test.ts:744-753`
```ts
  it("reviewContext: returns ok:true (GraphClient.reviewContext bypasses the narrow via runRaw)", async () => {
    const fixture = await loadCrFixture("get_review_context_tool.json");
    const client = makeCrClient("/repo", async () => fixture);
    const nodes = [{ id: "1", kind: "function" as const, file: "src/main.py", line: 5, symbol: "another" }];
    const r = await client.reviewContext(nodes);
    // ...the narrow is NOT invoked here, so r.data is the raw fixture object, not a string. Assert only .ok.
    expect(r.ok).toBe(true);
  });
```
**After the fix, rewrite to assert the narrowed STRING:**
```ts
  it("reviewContext: applies the cr-graph narrow — data is a JSON-stringified string", async () => {
    const fixture = await loadCrFixture("get_review_context_tool.json");
    const client = makeCrClient("/repo", async () => fixture);
    const nodes = [{ id: "1", kind: "function" as const, file: "src/main.py", line: 5, symbol: "another" }];
    const r = await client.reviewContext(nodes);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(typeof r.data).toBe("string");           // ← the Sprint-5 gap
      expect(r.data).toContain("changed_files");       // JSON.stringify(fixture) contains context.changed_files
    }
  });
```
Fixture confirms shape: `get_review_context_tool.json` top-level `{status:"ok", summary, context:{changed_files:["src/main.py"], graph:{changed_nodes,...}}}`. Keep the tokensave string test at `:312-320` UNCHANGED (byte-identical guard).

### onboard cr-graph test (sc-7-2) — `tests/graph/onboard.test.ts` (create)
Mock stack: `vi.mock` execa, `utils/fs`, `prereq` (ok+version), `config/loader` → `{graph:{enabled:true, backend:"code-review-graph", ...}}`, `artifact-store` (`readManifest` → `{backend:"code-review-graph", backendVersion:"2.3.7", indexedFileCount:2, ...}`), and `mcp-client` so `TokensaveMcpClient.call` returns `semantic_search_nodes_tool.json` for all 5 search calls. REAL `GraphClient` + REAL `resolveGraphBackend`. Then:
- Spy on `OnboardingComposer.prototype.render` (or mock the module) to capture `inputs.status.tokensaveVersion` → assert `=== "2.3.7"` (the cr-graph backendVersion, NOT a tokensave version).
- Assert the mocked `mcpClient.call` was invoked with tool `"semantic_search_nodes_tool"` (proves cr-graph exercised, not `tokensave_search`).
- Assert all 5 artifacts written: either mock `writeAll` and assert it got 5 named artifacts (`onboard.ts:204-210` list), or run against a temp `projectRoot` and `stat` the 5 files in `.bober/onboarding/`.

### mcp-server cr-graph test (sc-7-4) — extend `tests/mcp/external-server-graph.test.ts`
Wrap `GraphClient` with a Spy (like SpyCli) via `vi.mock("../../src/graph/client.js")`, mock `mcp-client` (`.start()` resolves), mock `configExists`→true + `loadConfig`→`{graph:{enabled:true, backend:"code-review-graph", exposeOnExternalMcp:true}, pipeline:{}}`. Call `createBoberMCPServer(tmp)` and assert the GraphClient spy received a 7th ctor arg with `.id === "code-review-graph"`. (server.ts uses dynamic `await import` for graph modules at `:84-90` → `vi.mock` intercepts.) Note: `createBoberMCPServer` connects a real `StdioServerTransport` + registers SIGINT/SIGTERM + event stream — noisy but non-blocking; keep the test in its own file/`describe` with `vi.resetModules()` in `beforeEach` (registry is a module singleton — see `:30-32`).

### E2E Test Pattern
Not applicable — no Playwright. `tests/graph/backends/code-review-graph-live.test.ts` uses `describe.skipIf`/`skip` when the real binary is absent (the "live onboard is optional, skip if binary missing" pattern from the contract assumptions).

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `tests/graph/client.test.ts:744-753` | `client.ts reviewContext` | **high** | MUST update — after the fix `r.data` is a string, not the raw object. Currently asserts only `.ok`; add `typeof === "string"`. |
| `tests/graph/client.test.ts:312-320` | `client.ts reviewContext` (tokensave) | low | MUST still pass UNCHANGED (byte-identical guard). |
| `tests/graph/mcp-client.test.ts:381-401` | `mcp-client.ts:243` binary resolution | **high IF Option A chosen** | This test relies on `cfg.tokensavePath ??` precedence inside mcp-client (passes default processSpec + `tokensavePath:"/custom/bin/tokensave"`, expects execa `/custom/bin/tokensave`). Dropping that precedence BREAKS it. → pick MEDIUM **Option B** to avoid touching it. |
| `tests/graph/mcp-client.test.ts:349-373` | `mcp-client.ts:243` | low | Passes default processSpec (binary "tokensave"), expects execa "tokensave" — safe under both options. |
| `tests/cli/graph-commands-backend.test.ts:198-227` | `graph.ts status` action | medium | Runs `graph status --json`, asserts execa `code-review-graph status --json` + captures stdout but does NOT assert JSON shape → additive JSON fields safe; keep existing human lines. |
| `tests/cli/graph-commands.test.ts:107-147` | `graph.ts status` + `onboard.ts` disabled path | low | Disabled-path only; unaffected by version-line + readout changes. |
| `src/graph/pipeline-lifecycle.ts:104-109` | `mcp-client` + processSpec | medium (MEDIUM fix) | 4th `TokensaveMcpClient` construction site (has `binary` at `:83`). If you thread the binary, update THIS site too or tokensavePath support regresses here. Covered by `tests/graph/pipeline-lifecycle.test.ts`. |

### Existing Tests That Must Still Pass (regression set)
- `tests/graph/client.test.ts` — tokensave reviewContext (`:312-320`), all search/query/impact/overview/changes happy paths; cr-graph e2e (`:707+`). Reviews the reviewContext fix.
- `tests/cli/graph-commands-backend.test.ts` — cr-graph init/sync/status through `TokensaveCli`. Confirms graph CLI parity unchanged.
- `tests/cli/graph-commands.test.ts` — disabled-path exit-1 for init/sync/status/onboard/impact.
- `tests/graph/mcp-client.test.ts` — binary resolution (`:349-401`), circuit breaker. Guards the MEDIUM fix.
- `tests/mcp/external-server-graph.test.ts` — 37 base + 6 graph tool registration counts (do NOT change the tool count).
- `tests/graph/backends/tokensave-backend.test.ts`, `code-review-graph-backend.test.ts`, `registry.test.ts`, `cli-backend-injection.test.ts`, `pipeline-lifecycle.test.ts`.

### Features That Could Be Affected
- **feat-5 (pluggable backend)** — shares `client.ts`, `registry.ts`, all 4 CLIs. Verify tokensave onboard/impact/graph/reviewContext outputs are byte-identical (the sprint's core invariant).
- **External MCP graph tools** — shares `server.ts` + `GraphClient`. The reviewContext fix flows into `graph_review_context`; verify `graph-tools.test.ts` / `external-server-graph.test.ts` unaffected.

### Recommended Regression Checks (run after implementation)
1. `npm run build && npm run typecheck` — zero errors (sc-7-1). Confirm `runRaw` removal (if done) leaves no dangling reference: `grep -n runRaw src/`.
2. `npx vitest run tests/graph/ tests/cli/ tests/mcp/` (scoped) — no NEW failures.
3. `npx vitest run` (full) — expect ≥ 5076 passed / 2 skipped / 0 failures (baseline), plus the new tests.
4. `npm run lint` — clean (watch for `no-unused` if `runRaw` kept but orphaned).
5. Byte-identical spot check: `npx vitest run tests/graph/client.test.ts -t "reviewContext returns ok:true with raw markdown"` passes unchanged; `tests/graph/mcp-client.test.ts -t "cfg.tokensavePath"` passes unchanged.

---

## 8. Implementation Sequence

1. **src/graph/client.ts** (HIGH follow-up) — rewrite `reviewContext` (`:91-94`) to `const {tool, params, narrow} = this.backend.reviewContextPlan(nodes); return this.runWithSandbox<string>(tool, params, narrow);`. Delete now-unused `runRaw` (`:215-218`) after `grep -n runRaw src/` confirms no other caller.
   - Verify: `npm run typecheck` clean; `tests/graph/client.test.ts:312-320` (tokensave) still green.
2. **tests/graph/client.test.ts** — update the cr-graph reviewContext test (`:744-753`) to assert `typeof r.data === "string"` + content. Keep the tokensave test unchanged.
   - Verify: `npx vitest run tests/graph/client.test.ts` green.
3. **src/cli/commands/onboard.ts** (sc-7-2) — line 141 → `manifest?.backendVersion ?? prereq.version ?? ""`.
   - Verify: typecheck; tokensave onboard behavior unchanged (backendVersion==tokensaveVersion on tokensave path).
4. **src/cli/commands/graph.ts** (sc-7-5) — in the existing `status` action (`:242-316`) add `engine`/`backendVersion`/`selectedBy` to the `output` object + additive human lines; compute `selectedBy = config.graph?.backend ? "config" : "auto-detect"`. Do NOT remove existing lines.
   - Verify: `graph-commands-backend.test.ts:198-227` still green.
5. **(OPTIONAL) MEDIUM binary-thread** — Option B: add helper `processSpecForBackend(backend, config) => ({ ...backend.processSpec(), binary: binaryForBackend(backend, config) })` in `registry.ts`; pass it at `onboard.ts:93-98`, `impact.ts:124-129`, `mcp/server.ts:96-101` (add `binaryForBackend` import there), AND `pipeline-lifecycle.ts:104-109`. Leave `mcp-client.ts:243` UNCHANGED.
   - Verify: `tests/graph/mcp-client.test.ts` (all binary tests) + `pipeline-lifecycle.test.ts` green.
6. **tests/graph/onboard.test.ts** (create, sc-7-2) — onboard through cr-graph + mocked transport; assert 5 artifacts + version line `2.3.7` + `call("semantic_search_nodes_tool", ...)`. Add an impact cr-graph test here or in a sibling (sc-7-3): assert `call("get_impact_radius_tool")` + `call("query_graph_tool")`.
   - Verify: green.
7. **tests/cli/graph-status.test.ts** (create, sc-7-5) — using the `graph-commands-backend.test.ts` mock stack, run `graph status` for `backend:"code-review-graph"` (assert `Engine: code-review-graph`, version, `Selected by: config`) AND a tokensave/auto-detect config (assert `Engine: tokensave`, `Selected by: auto-detect`).
   - Verify: green.
8. **tests/mcp/external-server-graph.test.ts** (extend, sc-7-4) — `createBoberMCPServer` with `graph.backend:"code-review-graph"`, GraphClient-spy asserts cr-graph backend.
   - Verify: green.
9. **Run full verification** — `npm run build`, `npm run typecheck`, `npx vitest run`, `npm run lint`. Commit: `bober(sprint-7): command parity (onboard/impact/graph/mcp) through resolved backend + graph status readout`.

---

## 9. Pitfalls & Warnings

- **reviewContext fix — use `runWithSandbox` + `narrow`, NOT a new codepath.** `runWithSandbox` does NOT apply `keepNode` on its own (keepNode lives only inside the per-method closures), so a string narrow is safe — identical to how `overview()` works (`client.ts:96-99`). Do not add NodeRef filtering.
- **`runRaw` becomes dead code.** After the fix it has no callers. Delete it (`client.ts:215-218`) or lint's `no-unused` may fail. `grep -n runRaw src/` first.
- **MEDIUM follow-up: choose Option B (thread binary via `processSpec.binary`), NOT Option A (drop `cfg.tokensavePath ??` in mcp-client).** Option A breaks the EXISTING `tests/graph/mcp-client.test.ts:381-401` (which supplies the override through `cfg.tokensavePath` and expects mcp-client to honor it) — a byte-identical/existing-test violation. Option B keeps `mcp-client.ts:243` untouched: for tokensave `cfg.tokensavePath ?? (tokensavePath??"tokensave")` == old behavior; for cr-graph `cfg.tokensavePath` is undefined so it falls to the resolved `codeReviewGraphPath`. Residual (documented, acceptable): a config that sets BOTH `tokensavePath` AND `backend:"code-review-graph"` still wrongly prefers `tokensavePath` — leave a `bober:` ceiling comment, do not force Option A.
- **MEDIUM touches `pipeline-lifecycle.ts` — a 4th construction site NOT in `estimatedFiles`.** If you thread the binary, you MUST update `pipeline-lifecycle.ts:104-109` too (it already has `binary` at `:83`), else nothing regresses functionally under Option B, but for consistency thread it. The MEDIUM fix is OPTIONAL for sc-7 (no criterion requires it) — the HIGH reviewContext fix + onboard/status/tests are the required deltas.
- **Do NOT change the `graph status` existing human lines or the JSON field `tokensaveVersion`.** ADD `Engine`/`Version`/`Selected by`. Other code and `--json` consumers read the existing shape; keep it a superset.
- **`OnboardingInputs.status.tokensaveVersion` is a TYPE field name** (`types.ts:122`) — the nonGoal forbids reworking onboard. Change only the *value source* at `onboard.ts:141`, not the field name.
- **Sandbox drops fixtures unless `projectRoot="/repo"`.** cr-graph fixtures use `/repo/src/...` paths; `keepNode` (`client.ts:240-251`) drops nodes outside projectRoot. For onboard/impact tests that assert non-empty results, construct GraphClient with `projectRoot="/repo"` (see `client.test.ts:708-730`). Onboard writes all 5 files regardless (composer renders empty sections), so if you only assert file COUNT the projectRoot doesn't matter — but the version-line + `call()` assertions do the real work.
- **MCP registry is a module singleton** — `tests/mcp/external-server-graph.test.ts` uses `vi.resetModules()` in `beforeEach` (`:30-32`). Follow it, or tool counts leak across tests.
- **server.ts loads graph modules via dynamic `await import`** (`:84-90`) — `vi.mock` on those paths works, but the mock must be registered before `createBoberMCPServer` runs. Use `vi.resetModules()` + dynamic `await import("../../src/mcp/server.js")` inside the test.
- **Explicit `graph.backend` short-circuits the resolver with NO probe** (`registry.ts:102-111`) — cr-graph tests are deterministic without a real binary on PATH. Do not add real-binary dependencies to the default suite (nonGoal / contract).
