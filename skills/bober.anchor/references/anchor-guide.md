# Anchor / Solana Development Reference Guide

## Anchor Project Structure

```
project-root/
  programs/                     # Solana programs (one or more)
    my-program/
      src/
        lib.rs                  # Program entry point, declares modules
        instructions/           # Instruction handler modules
          mod.rs                # Re-exports all instructions
          initialize.rs
          transfer.rs
        state/                  # Account struct definitions
          mod.rs
          user_account.rs
          vault.rs
        errors.rs               # Custom error definitions
        constants.rs            # Seeds, sizes, and other constants
      Cargo.toml                # Rust dependencies for this program
  tests/                        # Integration tests (TypeScript)
    my-program.ts
    helpers/
      setup.ts
      utils.ts
  app/                          # Optional client application
  sdk/                          # Optional TypeScript SDK
  migrations/                   # Anchor migration scripts
    deploy.ts
  target/                       # Build output (generated)
    idl/                        # Generated IDL files
    types/                      # Generated TypeScript types
    deploy/                     # Program keypairs
  Anchor.toml                   # Anchor workspace configuration
  Cargo.toml                    # Workspace Cargo.toml
  package.json
  tsconfig.json
```

**Key config (`Anchor.toml`):**
```toml
[features]
seeds = false
skip-lint = false

[programs.localnet]
my_program = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"

[programs.devnet]
my_program = "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"

[registry]
url = "https://api.apr.dev"

[provider]
cluster = "Localnet"
wallet = "~/.config/solana/id.json"

[scripts]
test = "yarn run ts-mocha -p ./tsconfig.json -t 1000000 tests/**/*.ts"
```

## Account Types and Constraints

### Common Account Types

```rust
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct Initialize<'info> {
    // Mutable signer -- the user paying for account creation
    #[account(mut)]
    pub payer: Signer<'info>,

    // New account to be created (init)
    #[account(
        init,
        payer = payer,
        space = 8 + UserAccount::INIT_SPACE,  // 8 bytes for discriminator
        seeds = [b"user", payer.key().as_ref()],
        bump,
    )]
    pub user_account: Account<'info, UserAccount>,

    // Existing account (validated by ownership and type)
    pub config: Account<'info, GlobalConfig>,

    // System program (required for account creation)
    pub system_program: Program<'info, System>,
}
```

### Account Data Struct

```rust
#[account]
#[derive(InitSpace)]
pub struct UserAccount {
    pub authority: Pubkey,       // 32 bytes
    pub balance: u64,            // 8 bytes
    pub is_active: bool,         // 1 byte
    pub bump: u8,                // 1 byte
    #[max_len(32)]
    pub name: String,            // 4 + 32 bytes (prefix + max chars)
    pub created_at: i64,         // 8 bytes
}
```

### Constraint Reference

```rust
#[derive(Accounts)]
pub struct UpdateUser<'info> {
    // Must be a signer
    pub authority: Signer<'info>,

    // Must be mutable, must match authority field, PDA with seeds+bump
    #[account(
        mut,
        has_one = authority,
        seeds = [b"user", authority.key().as_ref()],
        bump = user_account.bump,
    )]
    pub user_account: Account<'info, UserAccount>,

    // Custom constraint with error
    #[account(
        constraint = vault.balance > 0 @ CustomError::VaultEmpty
    )]
    pub vault: Account<'info, Vault>,

    // Close an account and send rent to a destination
    #[account(
        mut,
        close = authority,
        has_one = authority,
    )]
    pub account_to_close: Account<'info, TemporaryAccount>,

    // Realloc (resize) an account
    #[account(
        mut,
        realloc = 8 + UserAccount::INIT_SPACE + new_data_len,
        realloc::payer = authority,
        realloc::zero = false,
    )]
    pub resizable_account: Account<'info, UserAccount>,
}
```

### Token Account Constraints

```rust
use anchor_spl::token::{Mint, Token, TokenAccount};
use anchor_spl::associated_token::AssociatedToken;

#[derive(Accounts)]
pub struct TransferTokens<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    // Mint account
    pub mint: Account<'info, Mint>,

    // Source token account (must be owned by authority)
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = authority,
    )]
    pub source_ata: Account<'info, TokenAccount>,

    // Destination token account (init if needed)
    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = recipient,
    )]
    pub destination_ata: Account<'info, TokenAccount>,

    /// CHECK: recipient can be any account
    pub recipient: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
```

## PDA Patterns

### Basic PDA Derivation

```rust
// In constants.rs
pub const USER_SEED: &[u8] = b"user";
pub const VAULT_SEED: &[u8] = b"vault";
pub const CONFIG_SEED: &[u8] = b"config";

// In instruction context
#[account(
    init,
    payer = payer,
    space = 8 + UserAccount::INIT_SPACE,
    seeds = [USER_SEED, authority.key().as_ref()],
    bump,
)]
pub user_account: Account<'info, UserAccount>,

// In instruction handler -- store the bump for future use
pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
    let user = &mut ctx.accounts.user_account;
    user.authority = ctx.accounts.authority.key();
    user.bump = ctx.bumps.user_account;
    Ok(())
}
```

### PDA as Signer (for CPIs)

```rust
// When a PDA needs to sign a CPI
pub fn transfer_from_vault(ctx: Context<TransferFromVault>, amount: u64) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let seeds = &[
        VAULT_SEED,
        vault.authority.as_ref(),
        &[vault.bump],
    ];
    let signer_seeds = &[&seeds[..]];

    // CPI with PDA signer
    let cpi_accounts = Transfer {
        from: ctx.accounts.vault_token_account.to_account_info(),
        to: ctx.accounts.user_token_account.to_account_info(),
        authority: ctx.accounts.vault.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

    token::transfer(cpi_ctx, amount)?;
    Ok(())
}
```

### Multi-Seed PDAs

```rust
// PDA derived from multiple seeds
#[account(
    init,
    payer = payer,
    space = 8 + StakeRecord::INIT_SPACE,
    seeds = [
        b"stake",
        pool.key().as_ref(),
        user.key().as_ref(),
        &pool.stake_count.to_le_bytes(),
    ],
    bump,
)]
pub stake_record: Account<'info, StakeRecord>,
```

### Client-Side PDA Derivation (TypeScript)

```typescript
import { PublicKey } from "@solana/web3.js";

// Derive a PDA
const [userAccountPda, bump] = PublicKey.findProgramAddressSync(
  [Buffer.from("user"), authority.toBuffer()],
  programId
);

// Derive a PDA with multiple seeds
const [stakeRecordPda] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("stake"),
    poolPubkey.toBuffer(),
    userPubkey.toBuffer(),
    new anchor.BN(stakeCount).toArrayLike(Buffer, "le", 8),
  ],
  programId
);
```

## CPI Patterns

### Token Transfer CPI

```rust
use anchor_spl::token::{self, Transfer, Token};

pub fn transfer_tokens(ctx: Context<TransferTokens>, amount: u64) -> Result<()> {
    let cpi_accounts = Transfer {
        from: ctx.accounts.source.to_account_info(),
        to: ctx.accounts.destination.to_account_info(),
        authority: ctx.accounts.authority.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    token::transfer(CpiContext::new(cpi_program, cpi_accounts), amount)?;
    Ok(())
}
```

### Mint Tokens CPI

```rust
use anchor_spl::token::{self, MintTo, Token};

pub fn mint_tokens(ctx: Context<MintTokens>, amount: u64) -> Result<()> {
    let seeds = &[
        b"mint_authority",
        &[ctx.accounts.config.mint_authority_bump],
    ];
    let signer_seeds = &[&seeds[..]];

    let cpi_accounts = MintTo {
        mint: ctx.accounts.mint.to_account_info(),
        to: ctx.accounts.destination.to_account_info(),
        authority: ctx.accounts.mint_authority.to_account_info(),
    };
    let cpi_program = ctx.accounts.token_program.to_account_info();
    token::mint_to(
        CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds),
        amount,
    )?;
    Ok(())
}
```

### System Program CPI (SOL Transfer)

```rust
use anchor_lang::system_program::{self, Transfer};

pub fn transfer_sol(ctx: Context<TransferSol>, amount: u64) -> Result<()> {
    let cpi_accounts = Transfer {
        from: ctx.accounts.from.to_account_info(),
        to: ctx.accounts.to.to_account_info(),
    };
    let cpi_program = ctx.accounts.system_program.to_account_info();
    system_program::transfer(CpiContext::new(cpi_program, cpi_accounts), amount)?;
    Ok(())
}
```

## Testing with Bankrun

Bankrun provides a fast, in-process Solana test environment.

### Setup

```bash
npm install --save-dev solana-bankrun @solana/web3.js @coral-xyz/anchor
```

### Basic Bankrun Test

```typescript
import { startAnchor } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import { MyProgram } from "../target/types/my_program";
import IDL from "../target/idl/my_program.json";

describe("my-program", () => {
  let provider: BankrunProvider;
  let program: Program<MyProgram>;
  let payer: Keypair;

  beforeAll(async () => {
    const context = await startAnchor(".", [], []);
    provider = new BankrunProvider(context);
    program = new Program(IDL as MyProgram, provider);
    payer = context.payer;
  });

  it("initializes correctly", async () => {
    const [userPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("user"), payer.publicKey.toBuffer()],
      program.programId
    );

    await program.methods
      .initialize()
      .accounts({
        payer: payer.publicKey,
        userAccount: userPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([payer])
      .rpc();

    const account = await program.account.userAccount.fetch(userPda);
    expect(account.authority.toString()).toEqual(payer.publicKey.toString());
  });
});
```

### Testing with Local Validator

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { MyProgram } from "../target/types/my_program";

describe("my-program", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.MyProgram as Program<MyProgram>;

  it("initializes correctly", async () => {
    const [userPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("user"), provider.wallet.publicKey.toBuffer()],
      program.programId
    );

    const tx = await program.methods
      .initialize()
      .accounts({
        payer: provider.wallet.publicKey,
        userAccount: userPda,
      })
      .rpc();

    console.log("Transaction signature:", tx);

    const account = await program.account.userAccount.fetch(userPda);
    assert.ok(account.authority.equals(provider.wallet.publicKey));
  });

  it("rejects unauthorized access", async () => {
    const unauthorized = anchor.web3.Keypair.generate();

    try {
      await program.methods
        .adminOnlyInstruction()
        .accounts({
          authority: unauthorized.publicKey,
        })
        .signers([unauthorized])
        .rpc();
      assert.fail("Should have thrown");
    } catch (err) {
      assert.ok(err.message.includes("ConstraintHasOne") ||
                err.message.includes("Unauthorized"));
    }
  });
});
```

## Common Solana-Specific Issues

### Rent

All accounts on Solana must maintain a minimum balance (rent-exempt threshold). This is proportional to the account's data size.

```rust
// Calculate space for an account (include 8-byte discriminator for Anchor accounts)
space = 8 + UserAccount::INIT_SPACE

// In TypeScript, calculate minimum rent:
const rentExemptBalance = await connection.getMinimumBalanceForRentExemption(space);
```

**Common pitfall:** Forgetting the 8-byte Anchor discriminator when calculating space. Every Anchor account needs `8 + actual_data_size` bytes.

### Compute Budget

Each transaction has a default compute budget of 200,000 compute units per instruction. Complex operations may exceed this.

```typescript
// Request additional compute units
import { ComputeBudgetProgram } from "@solana/web3.js";

const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
  units: 400_000,
});

const tx = new Transaction()
  .add(modifyComputeUnits)
  .add(yourInstruction);
```

**Common pitfall:** Excessive `msg!()` logging consumes compute units. Minimize logging in production.

### Transaction Size

Solana transactions are limited to 1232 bytes. This includes:
- Signatures (64 bytes each)
- Message header (3 bytes)
- Account keys (32 bytes each)
- Recent blockhash (32 bytes)
- Instructions (variable)

**Mitigations:**
- Use Address Lookup Tables (ALTs) to reduce account key sizes
- Split large operations into multiple transactions
- Use versioned transactions (`MessageV0`)

```typescript
// Using Address Lookup Tables
import { AddressLookupTableProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

const messageV0 = new TransactionMessage({
  payerKey: payer.publicKey,
  recentBlockhash,
  instructions,
}).compileToV0Message([lookupTableAccount]);

const tx = new VersionedTransaction(messageV0);
```

### Account Size Limits

- Maximum account size: 10 MB (10,240 bytes for realloc per instruction)
- For large data, consider using multiple accounts or off-chain storage with on-chain hashes

### Clock and Timestamps

```rust
// Get current timestamp
let clock = Clock::get()?;
let current_timestamp = clock.unix_timestamp;  // i64
let current_slot = clock.slot;                 // u64

// Use in constraints
#[account(
    constraint = clock.unix_timestamp > stake.unlock_time @ CustomError::StillLocked
)]
pub stake: Account<'info, StakeRecord>,
```

**Common pitfall:** Solana's clock is based on validator consensus and can drift. Do not rely on exact second precision. Use slot numbers for ordering when possible.

### Serialization and Borsh

Anchor uses Borsh serialization. Be aware of:
- Strings are serialized as `length (4 bytes) + utf8 bytes`
- Vectors are serialized as `length (4 bytes) + elements`
- Options are serialized as `1 byte (tag) + value (if Some)`
- Enums are serialized as `1 byte (variant index) + variant data`

```rust
#[account]
#[derive(InitSpace)]
pub struct DataAccount {
    pub authority: Pubkey,        // 32 bytes
    pub count: u64,               // 8 bytes
    pub is_active: bool,          // 1 byte
    pub bump: u8,                 // 1 byte
    #[max_len(50)]
    pub name: String,             // 4 + 50 bytes
    #[max_len(10)]
    pub items: Vec<u64>,          // 4 + (10 * 8) bytes
    pub optional_field: Option<Pubkey>,  // 1 + 32 bytes
}
// Total INIT_SPACE = 32 + 8 + 1 + 1 + 54 + 84 + 33 = 213 bytes
// Account space = 8 (discriminator) + 213 = 221 bytes
```
