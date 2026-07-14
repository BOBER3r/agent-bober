---
name: bober.security-anchor
description: "Solana/Anchor program security signature library. Not a workflow skill -- a data file of discrete vulnerable/safe code signature blocks read by SecuritySignatureParser. Covers missing account constraints (has_one/owner/is_writable), deprecated unchecked sysvar/instruction loaders, missing signer checks, PDA seed collisions, init_if_needed re-initialization, CPI to unverified programs, and missing owner checks (arbitrary account substitution)."
---

# bober.security-anchor — Solana/Anchor Security Signature Library

This skill is a **signature-library** file, not a workflow skill. It is read (as raw
markdown text) by `SecuritySignatureParser.parse()`
(`src/orchestrator/security-knowledge/parser.ts`) and turned into typed
`SecuritySignature[]` records used by the security-audit agent team. Do not confuse this
with `bober.anchor`, which is the general Anchor development skill, or
`bober.security-audit`, which is the audit *workflow* skill.

## Signature Block Format

Each signature is a level-3 heading (three `#` characters, a space, then the
`signatureId`) followed by labelled fields and two fenced code examples. This file and
`SecuritySignatureParser` are one executable spec — keep them in sync.

Required fields per block:
- The heading text itself is the `signatureId` (must be non-empty).
- `- **Title:** <human-readable title>`
- `- **CWE:** CWE-xx` (optional — omit the line entirely for `cwe: null`)
- `- **Severity:** critical|high|medium|low|info`
- `- **VulnClass:** <a VulnClass union member, verbatim — see security-audit-types.ts>`
- `- **Invariant:** <the safety invariant this signature protects>`
- `- **Keywords:** comma, separated, keywords`

Then two labelled fenced code examples:
- `**Unsafe:**` followed by a fenced `ts` block with the vulnerable example.
- `**Safe:**` followed by a fenced `ts` block with the fixed example.

A block missing `Title`, a valid `VulnClass`, a valid `Severity`, or a non-empty
unsafe/safe example is dropped by the parser — never a fatal error.

## Signatures

### anchor.missing-account-constraints
- **Title:** Missing has_one/owner/is_writable account constraints
- **CWE:** CWE-862
- **Severity:** high
- **VulnClass:** authn-authz
- **Invariant:** Every account passed into an instruction is declared with the typed constraints (`has_one`, `owner`, `mut`) that bind it to the expected relationship — never a bare unconstrained `AccountInfo`.
- **Keywords:** has_one, Account, constraint, owner, mut

**Unsafe:**
```ts
#[account(mut)]
pub vault: AccountInfo<'info>, // no has_one, no owner check
```

**Safe:**
```ts
#[account(mut, has_one = authority)]
pub vault: Account<'info, Vault>,
```

### anchor.unchecked-sysvar-loader
- **Title:** Deprecated unchecked sysvar/instruction loader (Wormhole $326M root cause)
- **CWE:** CWE-345
- **Severity:** critical
- **VulnClass:** authn-authz
- **Invariant:** Instruction-introspection sysvar data is only ever read through the checked loader, which validates the sysvar account's identity before returning data.
- **Keywords:** load_instruction_at, load_instruction_at_checked, sysvar, instructions

**Unsafe:**
```ts
let ix = load_instruction_at(0, &ctx.accounts.instructions.data.borrow())?; // no sysvar identity check
```

**Safe:**
```ts
let ix = load_instruction_at_checked(0, &ctx.accounts.instructions)?; // verifies sysvar account id first
```

### anchor.missing-signer-check
- **Title:** Missing is_signer / Signer authority check
- **CWE:** CWE-862
- **Severity:** critical
- **VulnClass:** authn-authz
- **Invariant:** Any account authorizing a privileged action is typed as `Signer<'info>` (or explicitly asserted `is_signer`) so the instruction cannot be invoked on behalf of an address that never signed.
- **Keywords:** is_signer, Signer, authority, AccountInfo

**Unsafe:**
```ts
#[account()]
pub authority: AccountInfo<'info>, // never checked to have signed
```

**Safe:**
```ts
#[account()]
pub authority: Signer<'info>,
```

### anchor.pda-seed-collision
- **Title:** PDA seed collision / non-unique seeds
- **Severity:** high
- **VulnClass:** authn-authz
- **Invariant:** PDA seeds always include enough caller-specific data (e.g. the owning pubkey) that two distinct users can never derive the same program-derived address for logically separate state.
- **Keywords:** seeds, PDA, find_program_address, bump, collision

**Unsafe:**
```ts
#[account(init, seeds = [b"vault"], bump, payer = user, space = 8 + 32)]
pub vault: Account<'info, Vault>, // shared seed across every user
```

**Safe:**
```ts
#[account(init, seeds = [b"vault", user.key().as_ref()], bump, payer = user, space = 8 + 32)]
pub vault: Account<'info, Vault>,
```

### anchor.init-if-needed-reinit
- **Title:** init_if_needed re-initialization overwrite
- **Severity:** high
- **VulnClass:** race-condition
- **Invariant:** An account's initializing state transition happens exactly once — a second call against an already-initialized account is rejected rather than silently overwriting state.
- **Keywords:** init_if_needed, init, reinit, overwrite

**Unsafe:**
```ts
#[account(init_if_needed, seeds = [b"pos", user.key().as_ref()], bump, payer = user, space = 8 + 40)]
pub position: Account<'info, Position>, // re-invocation resets an already-open position
```

**Safe:**
```ts
#[account(init, seeds = [b"pos", user.key().as_ref()], bump, payer = user, space = 8 + 40)]
pub position: Account<'info, Position>, // init errors if the account already exists
```

### anchor.cpi-unverified-program
- **Title:** CPI to an unverified program id
- **CWE:** CWE-345
- **Severity:** critical
- **VulnClass:** privilege-escalation
- **Invariant:** A cross-program invocation only ever targets a hardcoded, expected program id — never a caller-supplied `AccountInfo` whose program identity is unchecked.
- **Keywords:** CPI, invoke, program_id, cross-program, token::ID

**Unsafe:**
```ts
invoke(&ix, &[ctx.accounts.token_program.clone(), ...])?; // token_program is caller-supplied, unverified
```

**Safe:**
```ts
require_keys_eq!(ctx.accounts.token_program.key(), token::ID);
invoke(&ix, &[ctx.accounts.token_program.clone(), ...])?;
```

### anchor.missing-owner-check
- **Title:** Missing account owner check (arbitrary account substitution)
- **CWE:** CWE-862
- **Severity:** critical
- **VulnClass:** authn-authz
- **Invariant:** Data read from an `AccountInfo` is only trusted after asserting the account is owned by the expected program — otherwise an attacker can substitute a look-alike account owned by a different program.
- **Keywords:** owner, AccountInfo, substitution, arbitrary

**Unsafe:**
```ts
let data = ctx.accounts.config.try_borrow_data()?; // no owner assertion before trusting the bytes
let cfg = Config::try_from_slice(&data)?;
```

**Safe:**
```ts
#[account(owner = crate::ID)]
pub config: Account<'info, Config>, // typed account enforces owner == program id
```
