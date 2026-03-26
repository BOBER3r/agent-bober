---
name: bober.anchor
description: "Solana program development workflow using Anchor. Plans program architecture, implements with proper account validation, and evaluates with build, test, and security checks. Use when building Solana programs, SPL tokens, or on-chain applications."
argument-hint: <program-description>
handoffs:
  - label: "Plan Program"
    command: /bober-plan
    prompt: "Plan the Solana program feature"
---

# bober.anchor — Solana Program Workflow

You are running the **bober.anchor** skill. This is a specialized workflow for building Solana programs using the Anchor framework. It covers project scaffolding, program architecture planning, implementation with proper account validation, and evaluation using build, test, and security checks.

## When to Use This Skill

Use `bober.anchor` when:
- Building new Solana programs from scratch (greenfield)
- Adding programs or instructions to an existing Anchor project
- The project involves: Solana programs, SPL tokens, on-chain applications, DeFi on Solana, NFT programs, or any Solana-native development

For EVM/Solidity work, use `bober.solidity`. For general projects, use `bober.run`.

## Stack Assumptions

This skill is optimized for:
- **Language:** Rust (with Anchor macros)
- **Framework:** Anchor 0.30+
- **Client SDK:** TypeScript with `@coral-xyz/anchor`
- **Testing:** Anchor integration tests (TypeScript), Bankrun for fast local testing, or `solana-test-validator`
- **Token standard:** SPL Token / Token-2022
- **Tooling:** Solana CLI, Anchor CLI, Rust/Cargo

If the user's stack differs (e.g., native Solana without Anchor, Seahorse/Python), adapt accordingly. These are defaults, not requirements.

## Step 1: Project Assessment

### Greenfield (New Project)

If there is no `Anchor.toml` in the project:

1. Ask the user to describe their program/application
2. Ask clarifying questions specific to Solana/Anchor projects:

```
**Q1: Program Type**
A) Token program (SPL Token, Token-2022, custom mint/transfer logic)
B) DeFi protocol (AMM, lending, staking, vault)
C) NFT/Metaplex program (minting, marketplace, collections)
D) Governance / DAO
E) Custom application logic (gaming, social, data storage)

**Q2: Token Standard**
A) SPL Token (standard, most compatible)
B) Token-2022 (extensions: transfer fees, confidential transfers, etc.)
C) No tokens involved
D) Both SPL Token and Token-2022 support

**Q3: Account Architecture**
A) Simple (few account types, straightforward PDAs)
B) Moderate (multiple account types, several PDAs, some relationships)
C) Complex (many account types, nested PDAs, cross-program invocations)

**Q4: Testing Approach**
A) Bankrun (fast, in-process validator simulation -- recommended)
B) Local validator (solana-test-validator, slower but full fidelity)
C) Both (Bankrun for unit tests, local validator for integration)

**Q5: Client SDK**
A) TypeScript SDK (most common, works with Anchor IDL)
B) Rust client (for CLI tools or backend services)
C) Both TypeScript and Rust clients
D) No client SDK needed (program only)
```

3. After answers, scaffold the project using Anchor

### Brownfield (Existing Anchor Project)

If `Anchor.toml` exists:

1. Analyze the existing setup:
   - Read `Anchor.toml` for program IDs, cluster config, and workspace settings
   - Read `Cargo.toml` for Rust dependencies
   - Check `programs/` directory for existing programs
   - Read existing program source files to understand account structures
   - Check for existing tests in `tests/` directory
   - Check for client SDK code in `app/` or `sdk/` directories
   - Read IDL files in `target/idl/` if they exist

2. Survey the program architecture:
   - Map all account structs and their constraints
   - Identify all instructions and their required accounts
   - List PDA derivation patterns
   - Identify CPI targets (other programs called)
   - Check for custom error definitions

3. Skip scaffolding -- proceed directly to planning

## Step 2: Initialize Configuration

Create or update `bober.config.json` with Anchor-optimized defaults:

```json
{
  "project": {
    "name": "<project-name>",
    "mode": "greenfield",
    "preset": "anchor",
    "description": "<user's program description>"
  },
  "planner": {
    "maxClarifications": 5,
    "model": "opus",
    "contextFiles": [
      "Anchor.toml",
      "Cargo.toml",
      "programs/"
    ]
  },
  "generator": {
    "model": "sonnet",
    "maxTurnsPerSprint": 50,
    "autoCommit": true,
    "branchPattern": "bober/{feature-name}"
  },
  "evaluator": {
    "model": "sonnet",
    "strategies": [
      { "type": "build", "required": true },
      { "type": "lint", "required": true },
      { "type": "unit-test", "required": true }
    ],
    "maxIterations": 3
  },
  "sprint": {
    "maxSprints": 10,
    "requireContracts": true,
    "sprintSize": "medium"
  },
  "pipeline": {
    "maxIterations": 20,
    "requireApproval": false,
    "contextReset": "always"
  },
  "commands": {
    "install": "npm install && anchor build",
    "build": "anchor build",
    "test": "anchor test",
    "lint": "cargo clippy --all-targets -- -D warnings",
    "dev": ""
  }
}
```

Adjust commands based on what actually exists in the project.

## Step 3: Scaffold (Greenfield Only)

For new projects, create the initial project structure.

### Anchor Scaffolding

```bash
anchor init <project-name>
cd <project-name>
```

Or if initializing in the current directory:
```bash
anchor init . --name <program-name>
```

Verify the initial setup:
```bash
anchor build
anchor test
```

### Post-Scaffold Setup

1. **Update Anchor.toml** with appropriate cluster and wallet configuration
2. **Update Cargo.toml** with additional dependencies if needed:
   - `anchor-spl` for SPL Token interactions
   - `mpl-token-metadata` for Metaplex NFT metadata
3. **Create program directory structure:**
   ```
   programs/<program-name>/src/
     lib.rs            # Program entry point
     instructions/     # Instruction handlers (one file per instruction)
       mod.rs
     state/            # Account structs and state definitions
       mod.rs
     errors.rs         # Custom error definitions
     constants.rs      # Program constants and seeds
   ```
4. **Set up test structure:**
   ```
   tests/
     <program-name>.ts    # Integration tests
     helpers/
       setup.ts           # Test setup utilities
       utils.ts           # Test helper functions
   ```
5. **Create initial git commit:**
   ```bash
   git init
   git add -A
   git commit -m "chore: initial scaffold from bober.anchor"
   ```

## Step 4: Plan the Feature

Run the full planning workflow with Anchor-specific enhancements:

### Program Architecture Planning

When planning a Solana program feature, consider:

1. **Account structures:** What accounts does the program need? What data do they store? What are the relationships between accounts?
2. **PDAs (Program Derived Addresses):** What PDAs are needed? What seeds derive each PDA? Are they unique per user, per token, per global state?
3. **Instructions:** What instructions does the program expose? What accounts does each instruction require? What are the signer requirements?
4. **Account validation:** What constraints apply to each account in each instruction? Size, ownership, initialization state, PDA derivation?
5. **CPIs (Cross-Program Invocations):** Does the program call other programs (System Program, Token Program, Associated Token Program, etc.)?
6. **Custom errors:** What error conditions exist? Define custom errors for each.
7. **Events:** What events should be emitted for off-chain indexing?

### Anchor-Specific Sprint Ordering

For a typical Solana program feature:

1. **Account definitions and state first:** Define all account structs, PDA seeds, and constants. This establishes the program's data model.
2. **Instruction handlers (core logic):** Implement the main instruction handlers one at a time, starting with initialization/creation instructions.
3. **State management and transitions:** Implement state transitions, validations, and business logic within instruction handlers.
4. **Client SDK:** Generate and extend the TypeScript client SDK from the Anchor IDL. Create helper functions for common operations.
5. **Integration tests:** Write comprehensive tests that exercise the full instruction flow, including error cases and edge cases.

### Anchor-Specific Success Criteria

Include these for every program sprint:

- "The program compiles successfully with `anchor build` and produces a valid BPF/SBF binary"
- "All account constraints are properly defined (signer checks, PDA derivation, ownership, space allocation)"
- "Custom errors are defined for all failure modes and used in constraint checks"
- "PDA derivation is correct: seeds match between creation and lookup"
- "All instruction handlers validate all required accounts"
- "Integration tests pass with `anchor test`"
- "No `cargo clippy` warnings in the program code"

### Anchor-Specific Evaluator Notes

- For build criteria, run `anchor build` and check for zero errors and zero warnings
- For lint criteria, run `cargo clippy` and check for zero warnings (with `-D warnings` flag)
- For test criteria, run `anchor test` and verify all tests pass
- For account validation criteria, review the Accounts structs for proper constraints
- For PDA criteria, verify seeds are consistent between instruction contexts and client code

## Step 5: Execute the Pipeline

Run the full sprint execution loop with Anchor-specific evaluation:

### Anchor-Specific Evaluation Enhancements

When evaluating Anchor sprints, the evaluator should additionally check:

1. **Program compilation:**
   - `anchor build` succeeds with zero errors
   - `cargo clippy` produces zero warnings
   - IDL is generated correctly in `target/idl/`

2. **Account validation:**
   - All accounts in instruction contexts have appropriate constraints:
     - `#[account(mut)]` for accounts that are modified
     - `#[account(signer)]` or marking as `Signer` type for accounts that must sign
     - `#[account(init, payer = ..., space = ...)]` for new accounts with correct space calculation
     - `#[account(seeds = [...], bump)]` for PDAs with correct seed derivation
     - `#[account(has_one = ...)]` for relationship validation
     - `#[account(constraint = ...)]` for custom validation logic
   - Account space calculations include the 8-byte discriminator
   - PDA bumps are stored and reused correctly

3. **PDA correctness:**
   - Seeds used in account derivation match between creation and lookup
   - PDA seeds are deterministic and unambiguous (no collisions)
   - Bump seeds are stored in account data for efficient re-derivation

4. **Error handling:**
   - Custom error enum defined with `#[error_code]`
   - Meaningful error messages for each error variant
   - Errors used in `require!()` and `constraint` checks
   - No panics or unwrap calls in instruction logic

5. **CPI safety:**
   - CPI calls use proper signer seeds for PDA-signed invocations
   - Account ownership is verified before passing accounts to CPI targets
   - Token program CPIs use the correct mint, authority, and token accounts

6. **Compute budget:**
   - Instructions stay within Solana's compute unit limits (default 200,000 per instruction)
   - Heavy computations are broken into multiple transactions if needed
   - Logging is minimal in production code (`msg!` uses compute units)

7. **Test quality:**
   - Tests cover the happy path for every instruction
   - Tests verify error cases (unauthorized signers, invalid accounts, constraint violations)
   - Tests verify PDA derivation matches expected addresses
   - Tests use proper setup/teardown with account creation

## Step 6: Post-Pipeline Verification

After all sprints pass, run a final comprehensive check:

1. **Full build:**
   ```bash
   anchor build
   ```

2. **Full test suite:**
   ```bash
   anchor test
   ```

3. **Clippy:**
   ```bash
   cargo clippy --all-targets -- -D warnings
   ```

4. **IDL verification:**
   - Check that `target/idl/<program>.json` exists and matches the program interface

5. **Report to user:**
   ```
   ## Solana Program Complete

   Your program is ready for review.

   ### How to Build & Test
   anchor build       # Compile the program
   anchor test        # Run integration tests
   anchor deploy      # Deploy to configured cluster

   ### What Was Built
   <Summary of program instructions and accounts>

   ### Program Architecture
   <Account diagram, PDA derivations, instruction flow>

   ### Security Notes
   <Key validation decisions, access control patterns>

   ### Deployment
   - Deploy to devnet first: anchor deploy --provider.cluster devnet
   - Program ID: <program-id from Anchor.toml>

   ### Next Steps
   - Review the program on branch: bober/<feature-slug>
   - Get a security audit before mainnet deployment
   - Deploy to devnet: anchor deploy --provider.cluster devnet
   - Test with the client SDK
   ```

## Next Steps

After completing this phase, suggest the following next steps to the user:
- `/bober-plan` — Plan the Solana program feature

## Error Handling

- **Build failures:** Common issues include Rust version mismatches, missing dependencies in Cargo.toml, and Anchor version incompatibilities. Check `anchor --version` and `rustc --version`.
- **Test failures:** Check that the local validator is not already running. Check that program IDs in tests match Anchor.toml. Ensure accounts are properly initialized before use.
- **Account size errors:** If accounts cannot be created due to insufficient space, recalculate space requirements including the 8-byte discriminator and all fields.
- **Compute budget exceeded:** Break heavy logic into multiple instructions or request additional compute units with `ComputeBudgetProgram.setComputeUnitLimit()`.
- **Transaction size exceeded:** Solana transactions are limited to 1232 bytes. If a transaction is too large, split into multiple transactions or use lookup tables for accounts.
- **PDA derivation mismatches:** Verify that seeds are identical in the program (Rust) and client (TypeScript). Watch for encoding differences (string vs bytes, endianness of numbers).
