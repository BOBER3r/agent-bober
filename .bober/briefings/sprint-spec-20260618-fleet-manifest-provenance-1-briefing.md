# Sprint Briefing: Provenance sidecar + recoverable, informative overwrite

**Contract:** sprint-spec-20260618-fleet-manifest-provenance-1
**Generated:** 2026-06-18T12:20:00Z

---

## 0. TL;DR

Add ONE new helper file `src/fleet/manifest-write.ts` exporting `writeManifestWithProvenance` + `ManifestProvenance` type + an injectable-clock relative-age formatter. Replace the TWO near-identical Step-4 write blocks in `src/fleet/index.ts` (`runFleetExpand` :207-224 and `runFleetExpandDeep` :343-360) with a single call to that helper. The helper: ensureDir → if outPath exists, read+tolerate `${outPath}.meta.json`, move prior manifest to `${outPath}.bak`, log informative non-blocking notice → atomic tmp+rename write → write `${outPath}.meta.json` provenance sidecar. Add `manifest-write.test.ts`. Update the overwrite-notice assertions in `expand.test.ts` and `expand-deep.test.ts` (the `/overwrite|overwritten/` regex). The shared default path `join(root,'.bober','fleet-expand.json')` is NOT changed. Provenance NEVER enters the manifest object.

---

## 1. Target Files

### src/fleet/manifest-write.ts (CREATE)

**Directory pattern:** Files in `src/fleet/` use kebab-case (`child-config.ts`, `decomposer-deep.ts`, `critic-deep.ts`). Each module is: imports → types/schemas → exported function(s) → no default export. Co-located `.test.ts` sibling.

**Most similar existing module for structure:** `src/fleet/manifest.ts` (imports node:fs/promises + zod, exports schema + functions, all named exports, `.js` ESM import extensions). Use it as the structural template.

**What the helper must do (from contract generatorNotes + evaluatorNotes):**
- Signature: `writeManifestWithProvenance({ outPath, manifest, provenance: { command, goal, critique, childCount }, log?, now? }): Promise<void>`
- `now?: () => number` defaults to `Date.now`; `log?` defaults to `console.log`.
- `ManifestProvenance` type = `{ command: string; goal: string; critique: boolean; childCount: number; timestamp: string }` (timestamp is the on-disk sidecar field; the call-arg `provenance` omits timestamp and the helper stamps it from `new Date(now()).toISOString()`).
- Derive `sidecarPath = `${outPath}.meta.json`` and `bakPath = `${outPath}.bak`` from the ACTUAL outPath (NOT the default constant).
- Steps: (1) `ensureDir(dirname(outPath))`; (2) check exists; (3) if exists: try-read+JSON.parse prior sidecar tolerating missing/corrupt → `null`, `rename(outPath, bakPath)` to preserve prior bytes, `log(notice)`; (4) atomic write new manifest (`randomBytes(4)` tmp + `writeFile` + `rename`, mirroring index.ts:217-220); (5) write the sidecar JSON.
- With prior sidecar: `[${command}] Replacing manifest from \`${prior.command}\` for goal "${prior.goal}" (${prior.childCount} children, ${relAge}) → kept as ${basename(outPath)}.bak`
- Without prior sidecar: `[${command}] Overwriting existing manifest at ${outPath} → kept as ${basename(outPath)}.bak`
- Relative-age formatter: `(now - Date.parse(prior.timestamp))` → `'just now'` / `'Nm ago'` / `'Nh ago'`. Add it as a small local function in this file (no existing util — see §3).

**Structure template (skeleton, based on manifest.ts + the index.ts write block):**
```ts
import { writeFile, rename, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, basename } from "node:path";
import { ensureDir } from "../state/helpers.js";
import type { FleetManifest } from "./manifest.js";

export interface ManifestProvenance {
  command: string;
  goal: string;
  critique: boolean;
  childCount: number;
  timestamp: string;
}

export interface WriteManifestArgs {
  outPath: string;
  manifest: FleetManifest;
  provenance: Omit<ManifestProvenance, "timestamp">;
  log?: (msg: string) => void;
  now?: () => number;
}

function formatRelativeAge(deltaMs: number): string { /* just now | Nm ago | Nh ago */ }

export async function writeManifestWithProvenance(args: WriteManifestArgs): Promise<void> {
  const { outPath, manifest, provenance } = args;
  const log = args.log ?? console.log;
  const now = args.now ?? Date.now;
  const sidecarPath = `${outPath}.meta.json`;
  const bakPath = `${outPath}.bak`;
  // ensureDir → exists? → read prior sidecar (tolerate) → rename(outPath,bakPath) → log notice
  // → atomic tmp write + rename → write sidecar { ...provenance, timestamp: new Date(now()).toISOString() }
}
```

---

### src/fleet/index.ts (MODIFY)

**Imports at top (lines 10-29) — currently used by the write blocks:**
- `import { join, dirname } from "node:path";` (line 12) — `dirname` becomes unused after refactor IF both blocks move to the helper; KEEP `join` (still used for default outPath). Verify `dirname` has no other use before removing (it does NOT — only the two write blocks use it). REMOVE `dirname` from line 12, and likely `writeFile, rename, access` (line 13) + `randomBytes` (line 14) become unused — remove them too, ESLint will flag unused imports (sc-1-3).
- `import { ensureDir } from "../state/helpers.js";` (line 25) — moves INTO the helper; remove from index.ts if no other use (it is only used in the two write blocks; remove).
- Add: `import { writeManifestWithProvenance } from "./manifest-write.js";`

**Relevant section A — `runFleetExpand` Step-4 (lines 207-224) to REPLACE:**
```ts
  // ── Step 4: atomic write ─────────────────────────────────────────
  const outPath = opts.out ?? join(root, ".bober", "fleet-expand.json");
  await ensureDir(dirname(outPath));

  const alreadyExisted = await access(outPath).then(() => true, () => false);

  const rnd = randomBytes(4).toString("hex");
  const tmp = `${outPath}.${process.pid}.${Date.now()}.${rnd}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2), { encoding: "utf-8" });
  await rename(tmp, outPath);

  if (alreadyExisted) {
    console.log(`[fleet expand] Overwritten existing manifest at: ${outPath}`);
  }
```
**Replace with:**
```ts
  // ── Step 4: atomic write with provenance + recoverable overwrite ──
  const outPath = opts.out ?? join(root, ".bober", "fleet-expand.json");
  await writeManifestWithProvenance({
    outPath,
    manifest,
    provenance: {
      command: "fleet expand",
      goal,                                  // RAW goal, NOT goalWithHint
      critique: false,
      childCount: manifest.children.length,
    },
  });
```
**In-scope vars at this point:** `manifest` (line 201), `goal` (param, line 171 — use RAW, NOT `goalWithHint` line 190), `opts`, `root` (line 199). KEEP `const outPath` because Step 5 (line 232-233) and Step 6 (line 240) reference it.

**Relevant section B — `runFleetExpandDeep` Step-4 (lines 343-360) to REPLACE:** identical pattern; the `console.log` says `[fleet expand-deep] Overwritten...` (line 359). Replace with the same helper call but:
```ts
    provenance: {
      command: "fleet expand-deep",
      goal,                                  // RAW goal, NOT goalWithHint (line 321)
      critique: opts.critique === true,
      childCount: manifest.children.length,
    },
```
`opts.critique` exists on `FleetExpandDeepOptions` (line 277). `goal` param is line 302.

**Imported by:** `src/cli.ts` (or main entry) calls `registerFleetCommand`; tests import `runFleetExpand`, `runFleetExpandDeep`, `registerFleetCommand` from `./index.js`. The function SIGNATURES do not change — only internal Step-4 bodies — so callers are unaffected.

**Test files:** `src/fleet/expand.test.ts`, `src/fleet/expand-deep.test.ts`, `src/fleet/expand-deep-critique.test.ts`, `src/fleet/index.test.ts` (all exist).

---

### src/fleet/manifest-write.test.ts (CREATE)

Mirror the temp-dir setup used by every fleet expand test (see §6). Inject a fixed `now` and a captured `log` for deterministic notice assertions. Cover all 8 success criteria (see §7).

---

## 2. Patterns to Follow

### Atomic tmp+rename write (move into the helper verbatim)
**Source:** `src/fleet/index.ts`, lines 217-220
```ts
  const rnd = randomBytes(4).toString("hex");
  const tmp = `${outPath}.${process.pid}.${Date.now()}.${rnd}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2), { encoding: "utf-8" });
  await rename(tmp, outPath);
```
**Rule:** Write to a uniquely-named tmp file then `rename` into place — never write outPath directly. Reuse this exact pattern in the helper. (Note: index.ts uses `Date.now()` for tmp uniqueness — that is fine; the INJECTED `now()` is only for the provenance timestamp + relative age, not for the tmp name.)

### access()-based existence check (returns boolean, never throws)
**Source:** `src/fleet/index.ts`, lines 212-215
```ts
  const alreadyExisted = await access(outPath).then(() => true, () => false);
```
**Rule:** Use `access(path).then(()=>true,()=>false)` to branch on existence without try/catch. Same idiom in `src/utils/fs.ts:10-17` (`fileExists`).

### Tolerant JSON read (do NOT throw on missing/corrupt sidecar)
**Source:** pattern derived from `src/fleet/manifest.ts:22-43` (load wraps readFile+JSON.parse in try/catch). For the sidecar, do NOT rethrow — return `null`:
```ts
  let prior: ManifestProvenance | null = null;
  try {
    const raw = await readFile(sidecarPath, "utf-8");
    prior = JSON.parse(raw) as ManifestProvenance;
  } catch { prior = null; }  // missing OR corrupt → generic notice (sc-1-6)
```
**Rule:** The sidecar is advisory; a missing/corrupt one must NEVER abort the write.

### Named ESM exports + `.js` import extensions
**Source:** `src/fleet/manifest.ts:1` (`import { readFile } from "node:fs/promises"`), `src/fleet/index.ts:16` (`import { load } from "./manifest.js"`)
**Rule:** All imports of local files end in `.js`; node builtins use `node:` prefix; type-only imports use `import type`. No default exports.

### ensureDir helper (reuse, do not reinvent)
**Source:** `src/state/helpers.ts:6-8`
```ts
export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}
```
**Rule:** index.ts already imports `ensureDir` from `../state/helpers.js` (line 25). The helper file must import it the same way: `import { ensureDir } from "../state/helpers.js";`. (There is ALSO an identical `ensureDir` in `src/utils/fs.ts:45` — prefer the one index.ts already uses, `../state/helpers.js`, for consistency.)

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `ensureDir` | `src/state/helpers.ts:6` | `(dirPath: string): Promise<void>` | mkdir recursive; reuse in the helper (index.ts already imports this one) |
| `ensureDir` (dup) | `src/utils/fs.ts:45` | `(path: string): Promise<void>` | identical second copy — do NOT add a third |
| `fileExists` | `src/utils/fs.ts:10` | `(path: string): Promise<boolean>` | access-based existence check (alternative to inline `access().then`) |
| `readJson<T>` | `src/utils/fs.ts:24` | `(path: string): Promise<T>` | read+parse JSON; THROWS on missing/corrupt — NOT suitable for the tolerant sidecar read (you need try/catch→null) |
| `writeJson` | `src/utils/fs.ts:34` | `(path: string, data: unknown): Promise<void>` | pretty JSON write + ensureDir; NOTE: it is NOT atomic (no tmp+rename) and appends a trailing newline — do NOT use for the manifest write (you need atomic). Could be used for the sidecar, but prefer plain writeFile to match the manifest formatting (`JSON.stringify(x, null, 2)`). |
| `load` / `FleetManifestSchema` | `src/fleet/manifest.ts:22,13` | `load(path):Promise<FleetManifest>` / zod schema | manifest loader+validator — UNCHANGED this sprint; tests use `FleetManifestSchema.safeParse` to assert AC7 |

**Relative-time / duration formatter:** NONE exists. `grep -rn "ago|relativeTime|formatDuration|humanize" src/utils/ src/fleet/` returned ZERO matches. Add a small LOCAL `formatRelativeAge(deltaMs)` inside `manifest-write.ts` — do not create a shared util.

**Utilities reviewed:** `src/utils/` (fs.ts, git.ts, logger.ts, index.ts), `src/state/helpers.ts` — relevant ones listed above.

---

## 4. Prior Sprint Output

No prior sprints in THIS spec (`dependsOn: []`). This sprint is a follow-up to two SHIPPED features it must preserve byte-compatibly:
- **`fleet expand`** (`runFleetExpand`, src/fleet/index.ts:170) — write block at :207-224.
- **`fleet expand-deep` + `--critique`** (`runFleetExpandDeep`, src/fleet/index.ts:301) — write block at :343-360; `opts.critique` flag at :277.

Both currently write the SAME default `join(root,'.bober','fleet-expand.json')` (lines 208 + 344) — the silent-clobber bug this sprint fixes (via sidecar + .bak, NOT by changing the path).

**Connection:** This sprint extracts their duplicated Step-4 into one shared helper and adds provenance/recoverability. It reuses their exact atomic-write idiom and `outPath` resolution.

---

## 5. Relevant Documentation

### Project Principles
`.bober/principles.md` exists (not fleet-specific; standard ESM/strict-TS/test-first conventions). Adhere to: strict typecheck, no `any`, `.js` ESM extensions, co-located tests.

### Architecture Decisions
**ADR-4 (Phase-2 expand), `.bober/architecture/arch-20260617-fleet-orchestrator-phase-2-expand-adr-4.md`:** `fleet <manifest>` (index.ts:135 / `runFleet`) is LOCKED byte-unchanged; expand surfaces are purely additive. This sprint must keep `runFleet` and the CLI registration untouched — only the two Step-4 write bodies change.

The plan's "ADR-4-preserving" note refers to the SINGLE SHARED DEFAULT PATH invariant: both expand commands intentionally share `<root>/.bober/fleet-expand.json`. This sprint does NOT change that path; provenance lives only in the `.meta.json` sidecar.

### Other Docs
No fleet-write doc beyond ADRs. `package.json` scripts: `build`=`tsc`, `typecheck`=`tsc --noEmit`, `lint`=`eslint src/`, `test`=`vitest`.

---

## 6. Testing Patterns

### Unit Test Pattern (temp-dir + DI + console spy)
**Source:** `src/fleet/expand.test.ts:1-12, 70-83, 341-377`
```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-expand-"));   // unique temp dir
  process.env["DEEPSEEK_API_KEY"] = "fake-key-for-test";
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// existence/absence assertions:
const raw = await readFile(outPath, "utf-8");          // file must exist
await expect(access(defaultPath)).rejects.toThrow();   // file must NOT exist

// console spy for the overwrite notice (expand.test.ts:355, 374-376):
const consoleSpy = vi.spyOn(console, "log");
const logCalls = consoleSpy.mock.calls.flat().join("\n");
expect(logCalls).toContain(outPath);
```
**Runner:** vitest. **Assertion:** `expect`. **Mock:** `vi.fn()`, `vi.spyOn`. **File naming:** `<name>.test.ts` co-located. 

**For `manifest-write.test.ts` (unit, no env-key needed):** call `writeManifestWithProvenance` directly with `out` in a `mkdtemp` dir, inject `now: () => FIXED_MS` and `log: (m) => logged.push(m)` so the notice is deterministic. Read `${outPath}.meta.json`, `${outPath}.bak`, and `outPath` with `readFile` and assert. Use `FleetManifestSchema.safeParse(JSON.parse(...))` for AC7 (import from `./manifest.js`).

### E2E Test Pattern
Not applicable — no Playwright for this CLI helper. Vitest unit tests only.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/fleet/index.ts` | new `./manifest-write.js` | medium | new import path resolves; `dirname`/`writeFile`/`rename`/`access`/`randomBytes`/`ensureDir` imports become unused → remove or ESLint fails (sc-1-3) |
| `src/fleet/expand.test.ts` | `runFleetExpand` behavior (notice text) | high | overwrite-notice assertion at :373-376 (`/overwrite|overwritten/`) — new generic message contains "Overwriting" (passes), but with-sidecar message says "Replacing…" (FAILS the regex). Update to also match the new wording. |
| `src/fleet/expand-deep.test.ts` | `runFleetExpandDeep` notice | high | identical assertion at :421-424 — same update needed |
| `src/fleet/expand-deep-critique.test.ts` | `runFleetExpandDeep` | low | NO overwrite-notice assertion present (verified) — likely no edit; contract says "if present". Run to confirm green. |
| `src/fleet/index.test.ts` | exports of index.ts | low | exercises registration; signatures unchanged → should stay green |

### Existing Tests That Must Still Pass
- `src/fleet/expand.test.ts` — write-and-stop (:66), --yes gate (:157), cred fail-fast (:249), overwrite+--out redirect (:321). The overwrite test (:341) asserts `parsed.children[0]?.folder === "second"` (recoverability of NEW file) and the notice; MUST still pass after the message change. The `--out redirect` test (:379) asserts default path NOT written — the helper must keep deriving from outPath.
- `src/fleet/expand-deep.test.ts` — mirror suites; overwrite test at :389, --out at ~:430.
- `src/fleet/expand-deep-critique.test.ts` — `--critique` threading + byte-lock + spawn-safety; the sidecar/bak additions must not perturb these (no notice assertion to update).
- `src/fleet/index.test.ts`, plus all other fleet suites (manifest, coordinator, etc.) — must remain green.

### NEW assertion lines to UPDATE (exact)
- `src/fleet/expand.test.ts:376` → `expect(logCalls.toLowerCase()).toMatch(/overwrite|overwritten/);` — broaden to also accept the new messages, e.g. `/overwrit|replacing|kept as/`, and optionally assert `.bak` is mentioned.
- `src/fleet/expand-deep.test.ts:424` → identical line, same broadening.
- (`expand-deep-critique.test.ts`: no such line — confirm by grep before editing.)

### Features That Could Be Affected
- **`fleet expand` and `fleet expand-deep`** share the new helper — verify BOTH still write a valid manifest, both produce a sidecar, and the `command`/`critique` fields differ correctly (`'fleet expand'`/false vs `'fleet expand-deep'`/`opts.critique`).
- **`--yes` chaining** (index.ts:238, 374) and **Step 5 manifest print** (index.ts:226-234, 362-370) must remain EXACTLY as-is — `outPath` stays in scope for them.

### Recommended Regression Checks (runnable)
1. `npm run build` — clean tsc (sc-1-1).
2. `npm run typecheck` — strict, no any (sc-1-2).
3. `npm run lint` — no unused-import errors from the removed node:fs imports (sc-1-3).
4. `npx vitest run src/fleet/manifest-write.test.ts src/fleet/expand.test.ts src/fleet/expand-deep.test.ts src/fleet/expand-deep-critique.test.ts` — targeted green.
5. `npm test` — full suite; ONLY the 6 pre-existing `tests/e2e`/cockpit-integration MCP "Connection closed" failures may remain (sc-1-8).
6. `git diff src/fleet/manifest.ts src/fleet/decomposer*.ts src/fleet/critic-deep.ts` — MUST be empty (scope guard, §9).

---

## 8. Implementation Sequence

1. **`src/fleet/manifest-write.ts`** — create. Define `ManifestProvenance` + args interface, `formatRelativeAge(deltaMs)` local fn, and `writeManifestWithProvenance` with injectable `now`/`log`. Import `ensureDir` from `../state/helpers.js`, type `FleetManifest` from `./manifest.js`, node:fs/promises + node:crypto + node:path. Mirror the atomic write at index.ts:217-220.
   - Verify: `npm run build` compiles the new file; no `any`.
2. **`src/fleet/index.ts`** — replace BOTH Step-4 blocks (:207-224, :343-360) with `writeManifestWithProvenance({...})` calls; pass RAW `goal`, correct `command`/`critique`/`childCount`. Add the new import; remove now-unused imports (`dirname` from :12, `writeFile, rename, access` :13, `randomBytes` :14, `ensureDir` :25 — confirm each has no remaining use). KEEP `const outPath` (Step 5/6 use it). Leave Step 5 + --yes gate untouched.
   - Verify: `npm run build` + `npm run lint` (no unused imports).
3. **`src/fleet/manifest-write.test.ts`** — create. Temp-dir setup (mkdtemp/rm), fixed `now`, captured `log`. Cover sc-1-4 (sidecar fields + RAW goal + childCount), sc-1-5 (first write: no notice/no .bak; overwrite: prior bytes in .bak, new bytes in outPath), sc-1-6 (fixed-clock relative-age string + missing/corrupt sidecar → no throw + generic notice + new sidecar written), sc-1-7 (custom outPath → custom .meta.json/.bak, default untouched), sc-1-8 (`FleetManifestSchema.safeParse` true + no provenance keys in manifest).
   - Verify: `npx vitest run src/fleet/manifest-write.test.ts` green.
4. **`src/fleet/expand.test.ts` + `src/fleet/expand-deep.test.ts`** — update the notice assertion (lines 376 and 424) to accept the new "Replacing… kept as .bak" / "Overwriting… kept as .bak" wording. Check `expand-deep-critique.test.ts` for a notice assertion (grep `overwrite`); edit only if present.
   - Verify: `npx vitest run` the 3-4 fleet expand suites.
5. **Run full verification** — `npm run build`, `npm run typecheck`, `npm run lint`, `npm test` (allow only the 6 known MCP failures).

---

## 9. Pitfalls & Warnings

- **Use RAW `goal`, NOT `goalWithHint`.** The `--count` hint is folded into `goalWithHint` (index.ts:190 / :321) for the decomposer ONLY. The sidecar `goal` must be the raw param (index.ts:171 / :302). Easy to grab the wrong variable.
- **Provenance must NEVER enter the manifest object.** The on-disk manifest (`outPath`) must still pass `FleetManifestSchema.safeParse` with EXACTLY `{ rootDir, concurrency, children }` (manifest.ts:13-17). Provenance lives only in `${outPath}.meta.json`.
- **Derive sidecar/.bak from `outPath`, not the default constant.** `--out` redirect tests (expand.test.ts:379, expand-deep.test.ts) assert the default `.bober/fleet-expand.json` is NOT touched. Hardcoding the default path breaks sc-1-7.
- **Move (rename) the prior manifest to .bak BEFORE writing the new one.** `rename(outPath, bakPath)` first, THEN tmp+rename the new manifest. Order matters: the .bak must contain the OLD bytes (sc-1-5 / evaluator check 2).
- **Tolerate missing/corrupt prior sidecar — do NOT throw.** Wrap the sidecar read in try/catch → `null`; print the generic notice in that case (sc-1-6). `readJson` from utils/fs.ts THROWS — do not use it here.
- **Remove now-unused imports in index.ts** or ESLint (sc-1-3) fails on `dirname`, `writeFile`, `rename`, `access`, `randomBytes`, `ensureDir`. Double-check each has zero remaining references before deleting (only the two write blocks use them — safe).
- **First write must print NO notice and create NO .bak** (sc-1-5). Only branch into the notice/.bak path when the file already exists.
- **Scope guard — DO NOT modify:** `src/fleet/manifest.ts`, `FleetManifestSchema`, `src/fleet/decomposer.ts`, `src/fleet/decomposer-deep.ts`, `src/fleet/critic-deep.ts`, `runFleet`, the CLI registration (`registerFleetExpand*Subcommand`), Step 5 print, the `--yes` gate. Only the two Step-4 write bodies + the new helper + tests change.
- **Injected `now` is for provenance timestamp + relative age ONLY** — the tmp filename can keep using `Date.now()` for uniqueness (matches index.ts:218). Do not let the injected clock make tmp names collide across calls in a test.
- **Notice is non-blocking — no prompts/stdin.** Just `log(...)`. Write-and-stop default and `--yes` gate behavior are unchanged (sc-1-8 / evaluator check 7).
