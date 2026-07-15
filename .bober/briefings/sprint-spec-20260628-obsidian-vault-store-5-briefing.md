# Sprint Briefing: Vault profile.yaml hook + Dataview/attachments conventions

**Contract:** sprint-spec-20260628-obsidian-vault-store-5
**Generated:** 2026-06-28T00:00:00.000Z

---

## 0. TL;DR for the Generator

Three deliverables, in dependency order:

1. **`src/vault/conventions.ts` (create)** — canonical home for `ACTIVE_STATUS='active'`, `SUPERSEDED_STATUS='superseded'`, `ATTACHMENTS_DIR='attachments'`. Single source of truth for the status literals.
2. **Convergence refactor (modify `index-map.ts` + `reindex.ts`)** — remove their two local `SUPERSEDED_STATUS` declarations and **re-export from `conventions.ts`** so the existing Sprint-2 test imports stay green byte-for-byte. **CRITICAL:** removing reindex.ts's local decl orphans its `NoteStatus` type import — you must delete that import too (`noUnusedLocals: true` will fail the build otherwise).
3. **`src/vault/profile.ts` (create) + `src/vault/profile.test.ts` (create)** — `resolveProfile(vaultDir)` reads `<vaultDir>/profile.yaml`, returns `undefined` if absent, `{ encrypted: true }` if a top-level `sops:` key is present, else the parsed `VaultProfile`. Reuse `parseFrontmatter` (the ONE YAML path) by wrapping the standalone YAML body in `---` delimiters.

No new YAML library (none is installed — verified). No crypto/network/clock. Use async `node:fs/promises` (vault convention).

---

## 1. Target Files

### src/vault/conventions.ts (create — NEW FILE)

**Directory pattern:** `src/vault/` uses kebab-case file names (`index-map.ts`, `note-io.ts`, `frontmatter.ts`). Module files open with a `/** ... */` header doc-comment (see every existing vault file). Named exports only.

**Most similar existing file for header style:** `src/medical/health-store.ts:1-16` (file-header doc-comment with PURE/ADR/bober annotations — mirror this shape). Also `src/vault/types.ts:1-7` for a small types/constants-only module header.

**Structure template (grounded in types.ts:1-7 + reindex.ts:25-30):**
```ts
/**
 * Vault conventions — canonical Dataview frontmatter status values and the
 * gitignored attachments directory name. Single source of truth so the reindex
 * path and downstream domains share ONE definition (no per-file duplicates).
 *
 * PURE: constants only — no fs, no clock, no network, no logic.
 */

import type { NoteStatus } from "./types.js";

/** Frontmatter status for a live note included in the active FactStore index. */
export const ACTIVE_STATUS: NoteStatus = "active";

/** Frontmatter status that excludes a note from the active index (reindex skip). */
export const SUPERSEDED_STATUS: NoteStatus = "superseded";

/**
 * Vault subdirectory holding binary attachments. Convention only — binary
 * attachments stay OUT of git (documentation, not runtime-enforced).
 */
export const ATTACHMENTS_DIR = "attachments";
```
**Note:** typing the status constants as `NoteStatus` (not `as const`) is safe — every consumer is either a value assertion (`.toBe("superseded")`) or an `unknown ===` comparison; nothing depends on the narrow literal type. `ATTACHMENTS_DIR` may use `as const` if a narrow type is wanted.

---

### src/vault/index-map.ts (modify)

**Current declaration to REPLACE (lines 74-80):**
```ts
// ── Sprint 5 consumption point ───────────────────────────────────────────────

/**
 * Frontmatter status value that marks a note as superseded.
 * Exported for Sprint 5 (status lifecycle) to consume — do NOT rename.
 */
export const SUPERSEDED_STATUS = "superseded" as const;
```
**Replace with a re-export** (index-map.ts does NOT use the value internally — only re-exports it):
```ts
// ── Sprint 5 convergence: canonical status lives in conventions.ts ───────────
export { SUPERSEDED_STATUS } from "./conventions.js";
```
**Why re-export, not delete:** `index-map.test.ts:2` does `import { noteToFacts, SUPERSEDED_STATUS } from "./index-map.js"` and asserts it at line 116. The re-export keeps that import path valid and the value byte-identical (`"superseded"`).

**Imports this file uses (unchanged):** `VaultNote` from `./types.js` (line 12), `FactInput` from `../state/facts.js` (line 13).
**Imported by:** `src/vault/reindex.ts:21` (`noteToFacts`), `src/vault/index-map.test.ts:2`.
**Test file:** `src/vault/index-map.test.ts` (exists). Has a source-purity test (lines 122-133) that reads `./index-map.ts` and asserts no `Date.now()`/`new Date()` — a re-export does not break it.

---

### src/vault/reindex.ts (modify)

**Current declaration to REPLACE (lines 23-30):**
```ts
// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Frontmatter status value that excludes a note from the active FactStore index.
 * Sprint 5 (status lifecycle) consumes this — do NOT rename.
 * Typed as NoteStatus to tie it to the documented enum in types.ts.
 */
export const SUPERSEDED_STATUS: NoteStatus = "superseded";
```
reindex.ts **USES the value internally** at line 85:
```ts
    // Skip superseded notes — they contribute no active facts to the index.
    if (note.frontmatter.status === SUPERSEDED_STATUS) continue;
```
So it needs the symbol BOTH in local scope AND re-exported. Replace the local const with an import + re-export:
```ts
import { SUPERSEDED_STATUS } from "./conventions.js";
// ...later, in the exports area, re-export for the Sprint-2 test import path:
export { SUPERSEDED_STATUS };
```
**CRITICAL build-breaker — remove the now-orphaned type import.** reindex.ts line 17 is:
```ts
import type { NoteStatus } from "./types.js";
```
`NoteStatus` was used ONLY to type the local `SUPERSEDED_STATUS` const at line 30. Once that const is gone, `NoteStatus` is unused. `tsconfig.json` sets `noUnusedLocals: true` (verified) → `tsc` (the `build` script) FAILS on the unused import. **Delete line 17.** (Line 16 `import type { VaultNote } from "./types.js";` stays — it is still used.)

**Imports this file uses:** `VaultNote` (line 16), `FactStore`/`ReconcileAction`/`writeFact` from `../state/facts.js` (18-19), `FactJudge` from `../orchestrator/memory/fact-judge.js` (20), `noteToFacts` from `./index-map.js` (21). After refactor: add `SUPERSEDED_STATUS` from `./conventions.js`, drop `NoteStatus`.
**Imported by:** `src/vault/reindex.test.ts:3`.
**Test file:** `src/vault/reindex.test.ts` (exists). Imports `{ reindexNotes, SUPERSEDED_STATUS } from "./reindex.js"` (line 3), uses `SUPERSEDED_STATUS` at lines 99, 122, 166. Source-purity test (lines 172-183) reads `./reindex.ts` for `Date.now()`/`new Date()` — unaffected.

---

### src/vault/profile.ts (create — NEW FILE)

**Most similar existing file for I/O shape:** `src/vault/note-io.ts:14-30` (`readNote` = `readFile` + parse). For ENOENT-tolerant read: `src/mcp/tools/incident.ts:142-151`.

**VaultProfile type:** the contract (assumption #56, non-goal "VaultProfile is a generic, mostly-open shape") says keep it generic — mirror `VaultNote.frontmatter` which is `Record<string, unknown>` (types.ts:17). Define it IN profile.ts (types.ts is NOT in estimatedFiles):
```ts
/** Generic, mostly-open vault profile. Domains add optional well-known keys at use sites. */
export type VaultProfile = Record<string, unknown>;
```

**Recommended resolver (grounded — see §2 for each cited pattern):**
```ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

export async function resolveProfile(
  vaultDir: string,
): Promise<VaultProfile | { encrypted: true } | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(vaultDir, "profile.yaml"), "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return undefined; // absent -> undefined
    throw err;
  }
  // profile.yaml is a STANDALONE YAML doc (no leading `---`). Wrap it so the ONE
  // existing parser (parseFrontmatter) handles it with the same scalar/list rules.
  const { frontmatter } = parseFrontmatter(`---\n${raw}\n---\n`);
  // SOPS marker is a STRUCTURAL key-presence check, NOT a truthiness/decrypt step.
  if ("sops" in frontmatter) return { encrypted: true };
  return frontmatter as VaultProfile;
}
```
**Return type is async (`Promise<...>`).** The contract writes the signature without the `Promise<>` wrapper, but the vault module mandates async I/O — `src/vault/note-io.ts:9` states verbatim: *"All fs access is via `node:fs/promises` (no sync variants)."* Follow that convention; the profile test is async anyway (mirrors note-io.test.ts).

**Test file:** `src/vault/profile.test.ts` (create — see §6).

---

## 2. Patterns to Follow

### Pattern A — The ONE YAML path: parseFrontmatter requires a leading `---`
**Source:** `src/vault/frontmatter.ts:53-61`
```ts
export function parseFrontmatter(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const lines = raw.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, body: raw };   // <-- no delimiter => frontmatter is {} !!
  }
```
**Gap & fix:** A standalone `profile.yaml` does NOT begin with `---`. Feeding it raw returns `{ frontmatter: {}, body: raw }` — **the keys are NOT parsed.** You MUST wrap: `parseFrontmatter(\`---\n${raw}\n---\n\`)`. This reuses the existing scalar/list rules (numbers via `NUM_REGEX` frontmatter.ts:26, inline lists frontmatter.ts:29, block lists frontmatter.ts:31-32) — no new parser. **Verified:** no `yaml`/`js-yaml` dependency exists in package.json, so this hand-rolled parser is genuinely the only YAML path.

**Companion signatures (frontmatter.ts):**
- `parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; body: string }` — line 53. Closing `---` searched at lines 64-70; `body` = everything after it (line 79).
- `serializeFrontmatter(frontmatter, body): string` — line 145.
- `parseNote(raw: string, path: string): VaultNote` — line 172 (calls parseFrontmatter; stores `path` verbatim, no fs).
- `serializeNote(note: VaultNote): string` — line 180.

### Pattern B — Parser flattens nested mappings; SOPS detection MUST be key-presence, not truthiness
**Source:** `src/vault/frontmatter.ts:100-120` (empty-value branch)
```ts
const rawVal = line.slice(colonIdx + 1).trim();
if (rawVal === "") {
  // Could be a block list or an empty value.
  const listItems: string[] = [];
  let j = i + 1;
  while (j < yamlLines.length && BLOCK_ITEM_REGEX.test(yamlLines[j])) { ... }
  if (listItems.length > 0) { frontmatter[key] = listItems; i = j; continue; }
  frontmatter[key] = "";   // <-- `sops:` with indented children => stored as EMPTY STRING
  i++;
  continue;
}
```
**Consequence:** For a SOPS file, the `sops:` line has an empty inline value and indented (non-`- `) children, so the parser stores `frontmatter["sops"] = ""` (empty string) and then **flattens** the indented `version:`/`mac:`/etc. into top-level keys (it trims leading whitespace off keys at line 94). Therefore:
- **Detect with `"sops" in frontmatter`** (key presence). Do NOT use `if (frontmatter.sops)` — the value is `""` which is falsy and would MISS the marker.
- The flattened junk keys never leak because you return the fresh literal `{ encrypted: true }` and stop. (Evaluator note: assert no field other than the marker is returned.)
**Rule:** SOPS detection = top-level `sops` key presence after the wrapped parse; short-circuit before touching any other field.

### Pattern C — ENOENT-tolerant file read (absent -> sentinel, never throw)
**Source:** `src/mcp/tools/incident.ts:142-151` (same idiom at `src/graph/onboarding-composer.ts:76`, `src/cli/commands/playbook.ts:97`)
```ts
try {
  meta = await readIncidentMetadata(projectPath, incidentId);
} catch (err) {
  if ((err as { code?: string }).code === "ENOENT") {
    return JSON.stringify({ error: `Incident not found: ${incidentId}` });
  }
  ...
}
```
**Rule:** `try { readFile } catch (err) { if ((err as { code?: string }).code === "ENOENT") return undefined; throw err; }` — missing profile returns `undefined`, real errors still propagate.

### Pattern D — File-header doc-comment style to mirror
**Source:** `src/medical/health-store.ts:1-16`
```ts
/**
 * HealthDataStore — SQLite-backed health observation store (Phase 6, Sprint 4).
 * ...
 * PURE: Never calls Date.now() or new Date() — every timestamp is an injected parameter.
 * ADR-4: Generic single-table pattern, ...
 * bober: in-memory or file-backed via better-sqlite3 (synchronous); swap for node:sqlite ...
 */
```
**Rule:** Open each new file with a `/** Title — one-line purpose. ... PURE: ... bober: ... */` block. Vault files already follow this (frontmatter.ts:1-19, index-map.ts:1-10, reindex.ts:1-14, types.ts:1-7).

### Pattern E — async node:fs/promises only (no sync variants)
**Source:** `src/vault/note-io.ts:9` and `:14`
```ts
* All fs access is via `node:fs/promises` (no sync variants).
...
import { readFile, writeFile } from "node:fs/promises";
```
**Rule:** Use `import { readFile } from "node:fs/promises";` in profile.ts (NOT `readFileSync`). Use `join` from `node:path` for `<vaultDir>/profile.yaml`.

---

## 3. Existing Utilities — DO NOT Recreate

| Utility | Location | Signature | Purpose |
|---------|----------|-----------|---------|
| `parseFrontmatter` | `src/vault/frontmatter.ts:53` | `(raw: string) => { frontmatter: Record<string,unknown>; body: string }` | THE single YAML-subset parser — reuse via the `---`-wrap trick (Pattern A). |
| `parseNote` | `src/vault/frontmatter.ts:172` | `(raw, path) => VaultNote` | Wraps parseFrontmatter + attaches path (not needed for profile, but proves the one path). |
| `serializeFrontmatter` | `src/vault/frontmatter.ts:145` | `(fm, body) => string` | YAML-subset serializer (not needed this sprint). |
| `readNote` | `src/vault/note-io.ts:27` | `(path) => Promise<VaultNote>` | readFile + parse template for resolveProfile's read step. |
| `listNotes` | `src/vault/note-io.ts:49` | `(vaultDir) => Promise<string[]>` | Glob `.md` under vault (not needed; shows vaultDir arg convention). |
| `ensureDir` | `src/utils/fs.ts` (imported at note-io.ts:19) | `(dir) => Promise<void>` | mkdir -p helper (NOT needed — non-goal: do not auto-create dirs). |
| `SUPERSEDED_STATUS` | `src/vault/index-map.ts:80` AND `src/vault/reindex.ts:30` | `"superseded"` | The duplicated literal you are converging into conventions.ts. |
| `noteToFacts` | `src/vault/index-map.ts:47` | `(note, opts) => FactInput[]` | Reindex mapper (untouched; just keep its re-export of the status valid). |
| `reindexNotes` | `src/vault/reindex.ts:66` | `(store, notes, opts) => Promise<ReindexSummary>` | Uses `SUPERSEDED_STATUS` at line 85 (untouched logic; import source changes). |

**Utilities reviewed:** `src/utils/` (fs.ts: `ensureDir`), `src/vault/` (frontmatter, note-io, index-map, reindex), `src/state/facts.ts` (FactStore) — none need recreating; no new util is required for this sprint beyond the three deliverable files.

---

## 4. Prior Sprint Output

### Sprint 1: parser + I/O + types (DEPENDS ON — the only declared dependency)
- **Created** `src/vault/frontmatter.ts` — exports `parseFrontmatter`/`parseNote`/`serializeFrontmatter`/`serializeNote`. **Connection:** resolveProfile reuses `parseFrontmatter` (Pattern A) so there is ONE YAML path.
- **Created** `src/vault/types.ts` — exports `VaultNote` and `NoteStatus = "active" | "superseded"` (types.ts:30). **Connection:** conventions.ts types `ACTIVE_STATUS`/`SUPERSEDED_STATUS` as `NoteStatus`; VaultProfile mirrors the open-`Record` shape of `VaultNote.frontmatter` (types.ts:17).
- **Created** `src/vault/note-io.ts` — async `node:fs/promises` read/write/list. **Connection:** establishes the async-fs convention resolveProfile must follow (Pattern E).

### Sprint 2: reindex + index-map (KNOWN DUPLICATION to converge here)
- **Created** `src/vault/index-map.ts` — `noteToFacts` + `export const SUPERSEDED_STATUS = "superseded" as const;` (line 80).
- **Created** `src/vault/reindex.ts` — `reindexNotes` + a SECOND `export const SUPERSEDED_STATUS: NoteStatus = "superseded";` (line 30), USED internally at line 85.
- **Connection:** This sprint makes `conventions.ts` the canonical owner and rewires both files to re-export from it (see §1 and §7). Literal value stays `"superseded"` so all Sprint-2 tests pass unchanged.

---

## 5. Relevant Documentation

### Project Principles
No `.bober/principles.md` consumed for this sprint's scope. The governing constraints come from the contract's `nonGoals`/`outOfScope`: (a) no SOPS encryption/decryption/key-mgmt — detect only; (b) never read/log/surface any value from an encrypted profile; (c) no `Date.now()`/`new Date()` in the resolver; (d) do NOT couple `VaultProfile` to medical fields; (e) do NOT auto-create profile.yaml or the attachments dir.

### Architecture Decisions
No ADR is specific to the vault profile hook. The vault module's own headers encode the relevant invariants: PURE-w.r.t.-clock (frontmatter.ts:12, reindex.ts:13-14, index-map.ts:4) and async-fs-only (note-io.ts:9). `src/medical/health-store.ts:11-13` shows the PURE/ADR header convention to mirror.

### Other Docs
`tsconfig.json` (verified): `strict: true`, `noUnusedLocals: true`, `noUnusedParameters: true`, `isolatedModules: true`, `module/moduleResolution: NodeNext`. ESM → all relative imports MUST carry the `.js` extension (e.g. `./conventions.js`, `./types.js`, `./frontmatter.js`). `package.json` scripts: `build = tsc`, `test = vitest`, `typecheck = tsc --noEmit`.

---

## 6. Testing Patterns

### Unit Test Pattern — inline string fixture (vault convention)
**Source:** `src/vault/frontmatter.test.ts:1-2, 14-27`
```ts
import { describe, it, expect } from "vitest";
import { parseFrontmatter, ... } from "./frontmatter.js";

const FIXTURE = `---
title: Test Note
weight: 5.4
tags:
  - alpha
  - beta
status: active
---
...`;
```
**Vault tests use INLINE multi-line template-string fixtures**, NOT a `__fixtures__/` dir. (The repo HAS `__fixtures__/` dirs under `src/medical/retrieval`, `src/fleet`, `src/orchestrator/workflow`, but `src/vault/` does not — follow the vault-local inline convention.)

### Filesystem test harness — temp dir via mkdtemp (for the on-disk read)
**Source:** `src/vault/note-io.test.ts:1-18`
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), "bober-vault-")); });
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }); });
```
**Apply to profile.test.ts:** because `resolveProfile` reads `<vaultDir>/profile.yaml` from disk, combine the two patterns — create a temp dir (note-io style), `writeFile(join(tmpDir, "profile.yaml"), PLAINTEXT_FIXTURE)` (inline string), then call `await resolveProfile(tmpDir)`. For sc-5-4 (missing file) just call `resolveProfile(tmpDir)` on an empty temp dir and assert `undefined`.

**Recommended profile.test.ts skeleton:**
```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProfile } from "./profile.js";
import { ACTIVE_STATUS, SUPERSEDED_STATUS, ATTACHMENTS_DIR } from "./conventions.js";

const PLAINTEXT = `owner: alice
domain: medical
created: 2026-06-28T00:00:00.000Z
tags:
  - primary
  - care
`;

// Minimal representative SOPS-encrypted YAML (top-level `sops:` metadata block).
const SOPS_ENCRYPTED = `name: ENC[AES256_GCM,data:Tr7o,iv:xY+a==,tag:zz9==,type:str]
sops:
    lastmodified: "2026-06-28T00:00:00Z"
    mac: ENC[AES256_GCM,data:9k0==,iv:aa1==,tag:bb2==,type:str]
    pgp: []
    unencrypted_suffix: _unencrypted
    version: 3.7.3
`;

describe("resolveProfile", () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "bober-profile-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("sc-5-2: parses plaintext profile.yaml into a typed VaultProfile", async () => {
    await writeFile(join(dir, "profile.yaml"), PLAINTEXT);
    const p = await resolveProfile(dir);
    expect(p).toMatchObject({ owner: "alice", domain: "medical" });
    expect((p as Record<string, unknown>).tags).toEqual(["primary", "care"]);
  });

  it("sc-5-3: SOPS-encrypted profile returns ONLY { encrypted: true }, never leaks/throws", async () => {
    await writeFile(join(dir, "profile.yaml"), SOPS_ENCRYPTED);
    const p = await resolveProfile(dir);
    expect(p).toEqual({ encrypted: true });            // exact — no extra fields
    expect((p as Record<string, unknown>).name).toBeUndefined(); // ciphertext not exposed
  });

  it("sc-5-4: missing profile.yaml returns undefined", async () => {
    expect(await resolveProfile(dir)).toBeUndefined();
  });
});

describe("conventions", () => {
  it("sc-5-4: exposes canonical status values + attachments dir", () => {
    expect(ACTIVE_STATUS).toBe("active");
    expect(SUPERSEDED_STATUS).toBe("superseded");
    expect(ATTACHMENTS_DIR).toBe("attachments");
  });
});
```
**Runner:** vitest. **Assertion style:** `expect(...)`. **Mock approach:** none — real temp-dir fs (manual mkdtemp/rm). **File naming:** `<module>.test.ts` co-located in `src/vault/`. **Location:** co-located (not `__tests__/`).

### Source-purity test (optional but matches the module convention)
**Source:** `src/vault/index-map.test.ts:122-133` — reads the `.ts` source and asserts it contains no `Date.now()`/`new Date()`. You MAY add the same for `profile.ts` to enforce the "no clock" non-goal:
```ts
const source = await readFile(new URL("./profile.ts", import.meta.url), "utf-8");
expect(source).not.toMatch(/Date\.now\(\)/);
```

### SOPS `sops:`-block fixture grounding
A real SOPS-encrypted YAML file ALWAYS carries a top-level `sops:` mapping that SOPS injects (independent of the encrypted payload above it). Representative top-level `sops:` fields: `version` (e.g. `3.7.3`), `mac` (an `ENC[...]` MAC), `lastmodified` (ISO timestamp, often quoted), `unencrypted_suffix` (`_unencrypted`), plus empty key-provider arrays `kms: []` / `gcp_kms: []` / `azure_kv: []` / `hc_vault: []` / `pgp: []`, and (for age) an `age:` recipients list. Data values above the block are `ENC[AES256_GCM,data:...,iv:...,tag:...,type:str]`. The minimal `SOPS_ENCRYPTED` fixture above is sufficient for the detection predicate (top-level `sops:` key present). The wrapped parser stores `sops` as `""` and flattens its children — that is fine; detection is `"sops" in frontmatter`.

---

## 7. Impact Analysis — Affected Features, Files & Tests

### Files That May Break
| File | Depends On | Risk | What to Check |
|------|-----------|------|---------------|
| `src/vault/index-map.test.ts:2,116` | `SUPERSEDED_STATUS` from `./index-map.js` | medium | Re-export must keep the symbol exported from index-map.js with value `"superseded"`. |
| `src/vault/reindex.test.ts:3,99,122,166` | `SUPERSEDED_STATUS` from `./reindex.js` | medium | Re-export must keep it exported from reindex.js; line 85 internal use must still resolve (import it into scope). |
| `src/vault/reindex.ts:85` | `SUPERSEDED_STATUS` (now imported) | high | The skip check `note.frontmatter.status === SUPERSEDED_STATUS` must still compile & behave identically. |
| `src/vault/reindex.ts:17` | `NoteStatus` type import | **high (build-breaker)** | After removing the local const, `NoteStatus` is unused → `noUnusedLocals` fails `tsc`. **Delete line 17.** |
| `src/vault/index-map.ts` (noteToFacts consumers) | n/a (logic untouched) | low | Only the SUPERSEDED_STATUS line changes; `noteToFacts` is unchanged. |

**Full blast radius of `SUPERSEDED_STATUS` (grep-verified across `src/`):** declared at `index-map.ts:80` + `reindex.ts:30`; imported/used at `reindex.ts:85`, `index-map.test.ts:2/116`, `reindex.test.ts:3/99/122/166`. **No file imports it from anywhere else** — no other module, CLI, or medical code references it. `ACTIVE_STATUS`, `ATTACHMENTS_DIR`, `resolveProfile`, `VaultProfile`, `conventions` currently have ZERO references in `src/` (all net-new). That is the complete set of edit sites.

### Existing Tests That Must Still Pass
- `src/vault/index-map.test.ts` — asserts `SUPERSEDED_STATUS).toBe("superseded")` (line 116) and `noteToFacts` mapping; must stay green after the re-export.
- `src/vault/reindex.test.ts` — asserts `SUPERSEDED_STATUS).toBe("superseded")` (line 166) AND uses it to build superseded-note fixtures (lines 99, 122) that drive the `status:superseded` skip behavior (sc-2-5). The skip semantics at reindex.ts:85 MUST be byte-identical.
- `src/vault/frontmatter.test.ts`, `src/vault/note-io.test.ts` — not touched, but confirm no accidental edit to frontmatter.ts (resolveProfile must NOT modify the parser).
- Both `*.test.ts` source-purity tests (index-map 122-133, reindex 172-183) — re-exports/import-removal do not introduce clock calls.

### Features That Could Be Affected
- **Reindex / status lifecycle (Sprint 2 feature)** — shares the `SUPERSEDED_STATUS` literal. Verify the `status:superseded` exclusion still drops superseded notes from the active index (`reindex.test.ts` sc-2-5 cases).
- No medical/fleet/orchestrator feature references these symbols (grep-confirmed) — zero cross-domain blast radius.

### Recommended Regression Checks
1. `npm run build` — `tsc` must pass (catches the orphaned `NoteStatus` import if line 17 isn't removed, and any missing `.js` extension on the new imports).
2. `npx vitest run src/vault/` — the entire vault suite (frontmatter, note-io, index-map, reindex, new profile) must be green; specifically index-map.test.ts:116 and reindex.test.ts:166/99/122.
3. `npm test` (full `vitest`) — confirm no pre-existing test elsewhere regressed.
4. Manually confirm the encrypted-fixture test asserts `toEqual({ encrypted: true })` (exact, no extra keys) — evaluator requires NO leaked field.

---

## 8. Implementation Sequence

1. **`src/vault/conventions.ts`** (create) — define `ACTIVE_STATUS`/`SUPERSEDED_STATUS` (typed `NoteStatus`, import from `./types.js`) and `ATTACHMENTS_DIR`. Header doc-comment per Pattern D.
   - Verify: `npx tsc --noEmit` compiles; values are the exact literals `active`/`superseded`/`attachments`.
2. **`src/vault/index-map.ts`** (modify) — replace lines 74-80 with `export { SUPERSEDED_STATUS } from "./conventions.js";`.
   - Verify: `npx vitest run src/vault/index-map.test.ts` stays green (line 116 assertion).
3. **`src/vault/reindex.ts`** (modify) — replace lines 23-30 with `import { SUPERSEDED_STATUS } from "./conventions.js";`; add `export { SUPERSEDED_STATUS };`; **delete the now-unused `import type { NoteStatus } from "./types.js";` (line 17).** Leave line 85 logic untouched.
   - Verify: `npx tsc --noEmit` passes (no unused `NoteStatus`); `npx vitest run src/vault/reindex.test.ts` green (lines 99/122/166 + sc-2-5 skip).
4. **`src/vault/profile.ts`** (create) — `VaultProfile` type + async `resolveProfile` using `readFile` (node:fs/promises), `join`, the `---`-wrap + `parseFrontmatter`, `"sops" in frontmatter` detection, and ENOENT→`undefined`. Header doc-comment per Pattern D (note PURE-no-clock, no crypto/network).
   - Verify: `npx tsc --noEmit` passes.
5. **`src/vault/profile.test.ts`** (create) — temp-dir harness (note-io.test.ts pattern) + inline plaintext & SOPS fixtures (frontmatter.test.ts pattern) covering sc-5-2/5-3/5-4, plus conventions assertions.
   - Verify: `npx vitest run src/vault/profile.test.ts` green.
6. **Full verification** — `npm run build` (tsc) → `npm test` (vitest). Confirm zero pre-existing regressions, especially the Sprint-2 vault tests.

---

## 9. Pitfalls & Warnings

- **`noUnusedLocals: true` build-breaker (HIGH):** After removing reindex.ts's local `SUPERSEDED_STATUS` const, its `import type { NoteStatus } from "./types.js";` (line 17) is orphaned and `tsc` FAILS. Delete that import. (index-map.ts has no such orphan — it never imported NoteStatus.)
- **Re-export, do NOT delete, the status export:** Sprint-2 tests import `SUPERSEDED_STATUS` directly from `./index-map.js` and `./reindex.js`. A plain delete breaks those imports. Use `export { SUPERSEDED_STATUS } from "./conventions.js";` (index-map) and `import {...}` + `export { SUPERSEDED_STATUS };` (reindex, since it also uses the value at line 85).
- **parseFrontmatter ignores input without a leading `---`:** feeding raw `profile.yaml` yields `{ frontmatter: {} }`. You MUST wrap in `---\n...\n---\n`. Do not write a second YAML parser (no `yaml`/`js-yaml` dep exists — verified).
- **SOPS detection is key-PRESENCE, not truthiness:** the wrapped parser stores `sops` as the empty string `""` (it cannot parse the nested mapping). `if (frontmatter.sops)` would be FALSY and miss it. Use `if ("sops" in frontmatter)`.
- **Never expose encrypted fields:** return the fresh literal `{ encrypted: true }` and stop. Do not spread or include any parsed key. The parser flattens the SOPS block's children (`version`, `mac`, …) and the `name: ENC[...]` data line into top-level keys — short-circuit BEFORE returning them.
- **No crypto/network/clock imports in profile.ts:** non-goals forbid `Date.now()`/`new Date()`, sops shell-out, and any crypto/network module. The only side effect is the `readFile`.
- **ESM `.js` extensions:** every relative import in the new/edited files needs `.js` (`./conventions.js`, `./types.js`, `./frontmatter.js`) — `module: NodeNext`.
- **Do NOT auto-create** `profile.yaml` or the `attachments/` directory (non-goal). `conventions.ts` only names the dir; nothing on disk is created.
- **Async vs sync signature:** the contract writes a sync-looking return type, but the vault module's own rule (note-io.ts:9 "no sync variants") mandates `node:fs/promises`. Implement `resolveProfile` as `async` returning a `Promise<...>`; the test awaits it.
- **Do not touch `frontmatter.ts`:** resolveProfile reuses the parser as-is. Editing the parser risks regressing frontmatter.test.ts / note-io.test.ts.
