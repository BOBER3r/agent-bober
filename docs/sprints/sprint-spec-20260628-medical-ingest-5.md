# Personalization profile.yaml (SOPS-encrypted, injectable cipher) + profile CLI

**Contract:** sprint-spec-20260628-medical-ingest-5  ·  **Spec:** spec-20260628-medical-ingest  ·  **Completed:** 2026-06-28

## What this sprint added

The **finale** of the medical-ingest plan: a Zod-validated personalization profile
(age / sex / conditions / medications / supplements / allergies / goals) persisted as a
**SOPS-encrypted `<vaultDir>/profile.yaml`**, behind an **injectable cipher seam** that
defaults to shelling out to `sops` (age backend) via `execa`. New module
`src/medical/profile.ts` holds the `ProfileSchema`, the `ProfileCipher` interface and its
default sops implementation, a hand-rolled flat-YAML emit/parse (no YAML dependency, no
`src/vault` import), the `writeProfile` / `readProfile` round-trip, and the two CLI cores.
Both read and write are **fail-closed**: `cipher.available()` is checked **before** any
serialization, encryption, or disk IO, so when `sops` is unavailable both paths reject with
a clear message and **plaintext PHI never reaches disk**. The new `bober medical profile
show` and `bober medical profile set <key> <value>` are nested subcommands under the
existing `medical` command tree.

## Public surface

- `bober medical profile show` (`src/cli/commands/medical.ts:330`) — decrypts `<vaultDir>/profile.yaml` and renders the profile to stdout. `--vault <dir>` overrides the vault dir (default `.bober/medical` under the project root). Nested subcommand under `medical`, not a top-level command.
- `bober medical profile set <key> <value>` (`src/cli/commands/medical.ts:339`) — updates one profile field after Zod validation, then re-encrypts and writes back. Array keys (`conditions`/`medications`/`supplements`/`allergies`/`goals`) accept a comma-separated value; `age`/`sex` are scalars. `--vault <dir>` overrides the vault dir.
- `ProfileSchema` / `Profile` (`src/medical/profile.ts:16`) — Zod object `{ age: int >= 0, sex: enum("male"|"female"|"other"), conditions/medications/supplements/allergies/goals: string[] (default []) }`. `parse` rejects a negative age and an unrecognized sex value with a `ZodError`.
- `interface ProfileCipher` (`src/medical/profile.ts:35`) — the injectable encryption seam: `available(): boolean` (synchronous — the caller gates IO on its return), `encrypt(plaintext): string | Promise<string>`, `decrypt(ciphertext): string | Promise<string>`. The default `createSopsCipher()` probes `sops --version` via `execaSync` for `available()` and shells out to `sops --encrypt/--decrypt` over stdin via `execa`.
- `writeProfile(vaultDir, profile, deps?): Promise<void>` (`src/medical/profile.ts:204`) — validates → checks `cipher.available()` (throws if false, writes nothing) → emits YAML → encrypts → writes `<vaultDir>/profile.yaml`. The only bytes that reach disk are ciphertext.
- `readProfile(vaultDir, deps?): Promise<Profile>` (`src/medical/profile.ts:231`) — checks `cipher.available()` (throws if false, no disk read) → reads → decrypts → parses → `ProfileSchema.parse`. `ProfileDeps { cipher?: ProfileCipher }` injects a reversible fake in tests; production callers omit it (default sops cipher).
- `runProfileShow(projectRoot, opts, deps?)` / `runProfileSet(projectRoot, key, value, opts, deps?)` (`src/medical/profile.ts:264` / `:302`) — the exported, testable command cores. Both **never throw**: on error they write stderr and set `process.exitCode = 1`. `set` starts from a safe default `{ age: 0, sex: "other" }` on an ENOENT read, updates one field, re-validates, and writes back.
- `emitProfileYaml(p)` / `parseProfileYaml(raw)` (`src/medical/profile.ts:110` / `:133`) — the PURE hand-rolled flat-YAML serializer/parser (flat scalars + `string[]` arrays). `parseProfileYaml` returns `unknown`; callers must validate through `ProfileSchema.parse`.

## How to use / how it fits

```bash
# Show the decrypted profile (requires sops with an age key configured):
bober medical profile show

# Set a scalar field:
bober medical profile set age 42
bober medical profile set sex female

# Set an array field (comma-separated):
bober medical profile set goals "lower ldl, improve sleep"
bober medical profile set allergies "penicillin, shellfish"

# Override the vault directory:
bober medical profile show --vault ~/health-vault
```

The profile is the small **structured** snapshot used for personalization; only it is
SOPS-encrypted (age backend, local, no egress). Free-text markdown bodies stay
plaintext-in-private-repo by design (research section 3b). The profile's lists are a
**denormalized personalization snapshot** — `FactStore` remains canonical for structured
medication/supplement facts. Goals are captured here for a downstream analysis pass (a
sibling spec); this sprint only stores them.

## Notes for maintainers

- **Fail-closed is the headline guarantee (sc-5-3).** `writeProfile` checks
  `cipher.available()` at `profile.ts:212` — **before** `emitProfileYaml` (`:218`) and
  `writeFile` (`:222`) — and `readProfile` checks at `:237` before `readFile` (`:242`).
  When sops is unavailable, both reject with a clear message and **no plaintext
  `profile.yaml` is ever written**. `available()` is deliberately **synchronous** so the
  caller can gate all IO on it.
- **The cipher is an injectable seam (ADR-style DI, like `WhoopSyncDeps` / `ImportLabsDeps`).**
  Tests inject a reversible fake cipher (base64 + `"SOPS:"` prefix) via `ProfileDeps.cipher`
  — **no real sops binary is invoked in the suite**. Swap `createSopsCipher` for a
  KMS-backed cipher when distributed key management is added; the age recipient / key path
  is **not parameterized here** (key distribution is operational, out of scope — contract
  assumption 3).
- **Hand-rolled YAML, no new dependency, no `src/vault` import.** `emitProfileYaml` /
  `parseProfileYaml` handle only flat scalars and `string[]` arrays — quoted/nested/multi-line
  values are unsupported. Mirrors the Sprint 2 (`lab-note.ts`) and Sprint 4
  (`supplements.ts`) choice to stay independent of the sibling `src/vault` spec's timing.
  `execa` is already vendored (used by the fleet orchestrator), so no new deps were added.
- **`set` is read-modify-write.** It reads the existing profile (or a safe default on
  ENOENT), updates one field, re-validates the **whole** object via `ProfileSchema.parse`,
  and re-encrypts — so an invalid value (e.g. a negative age) is rejected before anything is
  written.
- **Scope.** Commit `9895965`: new `src/medical/profile.ts` + `src/medical/profile.test.ts`
  (13 tests) and a +26-line nested `profile show|set` subtree in
  `src/cli/commands/medical.ts`. No new deps. Full suite **2975** green (+13), all four
  criteria (sc-5-1..sc-5-4) passed iteration 1. **The plan is complete (5 of 5).**
