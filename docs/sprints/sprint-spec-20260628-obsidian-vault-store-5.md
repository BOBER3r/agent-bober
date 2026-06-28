# Vault profile.yaml hook + Dataview/attachments conventions

**Contract:** sprint-spec-20260628-obsidian-vault-store-5  ·  **Spec:** spec-20260628-obsidian-vault-store  ·  **Completed:** 2026-06-28

## What this sprint added

The **final sprint of the 5-sprint vault storage layer** (`spec-20260628-obsidian-vault-store`). It
adds two small but load-bearing pieces and one refactor. First, `resolveProfile(vaultDir)` recognizes
an optional `profile.yaml` at a vault root: it parses plaintext YAML into a typed `VaultProfile`,
**detects a SOPS-encrypted profile without decrypting it** (returning an opaque `{ encrypted: true }`
marker), and returns `undefined` when the file is absent. This leaves a clean hook for later SOPS
wiring while implementing **no** encryption. Second, `conventions.ts` becomes the single source of
truth for the canonical Dataview frontmatter status values (`active` / `superseded`) and the
gitignored attachments directory name. Third, a **convergence refactor** centralizes the
`SUPERSEDED_STATUS` constant that Sprints 2 had duplicated in `index-map.ts` and `reindex.ts` —
both now import-and-re-export it from `conventions.ts`, keeping every Sprint-2 test import path
byte-identical. **With this sprint the vault storage layer is complete (5 of 5).**

## Public surface

- `resolveProfile(vaultDir): Promise<VaultProfile | { encrypted: true } | undefined>`
  (`src/vault/profile.ts:38`) — reads `<vaultDir>/profile.yaml` via `node:fs/promises`. Returns the
  parsed `VaultProfile` for plaintext YAML, the opaque `{ encrypted: true }` sentinel when a top-level
  `sops:` key is present, and `undefined` on ENOENT (no throw). Reuses the **Sprint 1**
  `parseFrontmatter` as the one YAML path by wrapping the standalone document in `---` delimiters.
- `VaultProfile` type (`src/vault/profile.ts:27`) — `Record<string, unknown>`, an intentionally
  generic, mostly-open shape. No medical or financial fields are hardcoded, so other domains reuse it
  without coupling.
- `ACTIVE_STATUS` (`src/vault/conventions.ts:16`) — `NoteStatus` literal `"active"`; the frontmatter
  status for a live note included in the active FactStore index.
- `SUPERSEDED_STATUS` (`src/vault/conventions.ts:19`) — `NoteStatus` literal `"superseded"`; the
  status that excludes a note from the active index (the reindex skip). This is now the **canonical**
  home for the constant.
- `ATTACHMENTS_DIR` (`src/vault/conventions.ts:26`) — `"attachments"`; the vault subdirectory for
  binary attachments. Convention only — its doc-comment records that binary attachments stay **out of
  git** (add to `.gitignore`); nothing is auto-created or enforced at runtime.

## How to use / how it fits

```ts
const profile = await resolveProfile(vaultDir);
if (profile === undefined) {
  // no profile.yaml — proceed without one
} else if ("encrypted" in profile) {
  // SOPS-encrypted: detected but NOT decrypted. Defer to a future SOPS-aware path.
} else {
  // plaintext VaultProfile (open record) — read domain keys at the use site
}
```

SOPS detection is **key-presence, not truthiness**: SOPS always adds a top-level `sops:` metadata
block to an encrypted file, and the Sprint 1 parser stores `sops:` (with its indented children) as an
empty string, which is falsy — so the resolver uses `"sops" in frontmatter` to detect it regardless of
value. When the encrypted marker is returned, **no other field is exposed** — no ciphertext or value
leaks. The conventions constants give the reindex path and downstream domains one definition for the
status lifecycle, replacing the per-file `SUPERSEDED_STATUS` literals introduced in Sprint 2.

## Notes for maintainers

- **The resolver is clock/crypto/network-free.** `resolveProfile` never calls `Date.now()`/`new Date()`
  and imports no crypto, network, or sops-binary module — SOPS handling is structural detection only.
  (The doc-comment at `src/vault/profile.ts:10-11` contains the literal text `Date.now()` describing
  this guarantee; a source-purity grep over the file would false-positive on that comment, so the
  generator omitted an automated purity test — the contract's four criteria do not require one.)
- **`SUPERSEDED_STATUS` is now canonical in `conventions.ts`.** `src/vault/index-map.ts` and
  `src/vault/reindex.ts` replaced their local declarations with `export { SUPERSEDED_STATUS } from
  "./conventions.js"` (and a plain `export { SUPERSEDED_STATUS }` re-export, respectively), so the
  Sprint-2 tests that import it from those modules stay green (20 convergence tests verified). The
  refactor also removed an orphaned `NoteStatus` type import from `reindex.ts` that would otherwise
  have broken the `noUnusedLocals` build gate. If you add a new status, add it here first.
- **`ATTACHMENTS_DIR` is documentation, not enforcement.** Nothing writes `.gitignore` or creates the
  directory; it is a shared constant + convention. Swap for a runtime guard only if a future
  requirement mandates enforcement.
- **`profile.yaml` is the SOPS hook location.** Sprint 3's `bober vault reindex` defaults `--vault` to
  the project root because there was no config-declared vault path; the `profile.yaml` hook is the
  natural future home for vault-level metadata (and, eventually, the actual SOPS decryption wiring that
  this sprint deliberately leaves unimplemented).
- **Scope.** Commit `bb95d3b`: new `src/vault/conventions.ts` + `src/vault/profile.ts` +
  `src/vault/profile.test.ts` (4 tests, temp-dir harness with inline fixtures), plus the convergence
  edits to `index-map.ts` and `reindex.ts`. No new deps; `facts.ts`/`reconcile.ts` and the Sprint
  1–4 vault modules are otherwise untouched. Full suite **2911 tests** green, zero regressions; all
  four criteria (sc-5-1..sc-5-4) passed iteration 1. (Eval was run directly by the orchestrator
  because the evaluator subagent hit a session limit — every strategy and criterion was independently
  re-executed.)
