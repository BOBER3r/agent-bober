---
name: bober.solidity
description: "EVM smart contract development workflow. Scaffolds Hardhat or Foundry projects, plans contract architecture, implements with security best practices, and evaluates with compilation, linting, and test coverage. Use when building Solidity smart contracts, DeFi protocols, NFT projects, or DAOs."
argument-hint: <contract-description>
handoffs:
  - label: "Plan Contract"
    command: /bober-plan
    prompt: "Plan the smart contract feature"
---

# bober.solidity — EVM Smart Contract Workflow

You are running the **bober.solidity** skill. This is a specialized workflow for building Solidity smart contracts targeting the Ethereum Virtual Machine (EVM). It covers project scaffolding, contract architecture planning, implementation with security best practices, and evaluation using compilation, linting, testing, and gas analysis.

## When to Use This Skill

Use `bober.solidity` when:
- Building new EVM smart contracts from scratch (greenfield)
- Adding contracts or features to an existing Hardhat/Foundry project
- The project involves: Solidity contracts, DeFi protocols, NFT collections, DAOs, token launches, or any EVM-compatible chain deployment

For non-Solidity blockchain work (e.g., Solana/Anchor), use `bober.anchor`. For general projects, use `bober.run`.

## Stack Assumptions

This skill is optimized for:
- **Language:** Solidity 0.8.x+
- **Frameworks:** Hardhat (TypeScript) or Foundry (Rust tooling)
- **Libraries:** OpenZeppelin Contracts, Solmate, or custom implementations
- **Testing:** Hardhat tests (Mocha/Chai + ethers.js) or Foundry tests (Solidity-based with forge)
- **Linting:** solhint
- **Deployment:** Hardhat Ignition, Foundry scripts, or custom deploy scripts
- **Verification:** Etherscan/Sourcify verification

If the user's stack differs, adapt accordingly. These are defaults, not requirements.

## Step 1: Project Assessment

### Greenfield (New Project)

If there is no `hardhat.config.ts`, `hardhat.config.js`, or `foundry.toml` in the project:

1. Ask the user to describe their contract/protocol
2. Ask clarifying questions specific to Solidity projects:

```
**Q1: Development Framework**
A) Hardhat (TypeScript, most popular, large plugin ecosystem)
B) Foundry (Rust tooling, Solidity-native tests, faster compilation)
C) Both (Hardhat for deployment/scripts, Foundry for testing)

**Q2: Contract Type**
A) Token (ERC-20, ERC-721, ERC-1155)
B) DeFi protocol (AMM, lending, staking, vault)
C) Governance (Governor, Timelock, multisig)
D) Custom application logic
E) Upgradeable contracts (proxy pattern)

**Q3: Security Libraries**
A) OpenZeppelin Contracts (battle-tested, most audited)
B) Solmate (gas-optimized, minimal)
C) Custom implementations (for advanced use cases)
D) Mix of the above

**Q4: Target Chain**
A) Ethereum mainnet
B) L2 (Optimism, Arbitrum, Base, zkSync)
C) EVM-compatible L1 (Polygon, Avalanche, BSC)
D) Multi-chain deployment
E) Testnet only for now

**Q5: Upgradeability**
A) Immutable contracts (simpler, more trustless)
B) Transparent Proxy (OpenZeppelin)
C) UUPS Proxy (OpenZeppelin)
D) Diamond/EIP-2535 (multi-facet proxy)
E) Not sure yet
```

3. After answers, scaffold the project using the appropriate framework

### Brownfield (Existing Solidity Project)

If `hardhat.config.ts`, `hardhat.config.js`, or `foundry.toml` exists:

1. Analyze the existing setup:
   - Read the framework config file
   - Check `package.json` (Hardhat) or `foundry.toml` (Foundry) for dependencies
   - Read `contracts/` or `src/` directory for existing contracts
   - Check for OpenZeppelin imports, Solmate imports, or custom base contracts
   - Check for existing tests in `test/` or `test/` directories
   - Check for deployment scripts in `scripts/`, `deploy/`, or `script/`
   - Read any existing `.sol` interfaces for contract architecture

2. Survey the contract architecture:
   - Map contract inheritance hierarchies
   - Identify access control patterns (Ownable, AccessControl, custom)
   - Check for proxy/upgrade patterns
   - List external contract integrations (oracles, DEXs, lending protocols)

3. Skip scaffolding -- proceed directly to planning

## Step 2: Initialize Configuration

Create or update `bober.config.json` with Solidity-optimized defaults:

```json
{
  "project": {
    "name": "<project-name>",
    "mode": "greenfield",
    "preset": "solidity",
    "description": "<user's contract description>"
  },
  "planner": {
    "maxClarifications": 5,
    "model": "opus",
    "contextFiles": [
      "hardhat.config.ts",
      "foundry.toml",
      "contracts/",
      "src/"
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
    "install": "npm install",
    "build": "npx hardhat compile",
    "test": "npx hardhat test",
    "lint": "npx solhint 'contracts/**/*.sol'",
    "dev": ""
  }
}
```

For Foundry projects, adjust commands:
```json
{
  "commands": {
    "install": "forge install",
    "build": "forge build",
    "test": "forge test -vvv",
    "lint": "npx solhint 'src/**/*.sol'",
    "dev": ""
  }
}
```

Adjust based on what actually exists in the project.

## Step 3: Scaffold (Greenfield Only)

For new projects, create the initial project structure.

### Hardhat Scaffolding

```bash
npx hardhat init  # Select TypeScript project
npm install --save-dev @openzeppelin/contracts solhint
npm install --save-dev @nomicfoundation/hardhat-toolbox
```

Create project structure:
```
contracts/
  interfaces/
  libraries/
  mocks/
test/
  unit/
  integration/
scripts/
  deploy/
.solhint.json
hardhat.config.ts
```

Create `.solhint.json`:
```json
{
  "extends": "solhint:recommended",
  "rules": {
    "compiler-version": ["error", "^0.8.20"],
    "func-visibility": ["warn", { "ignoreConstructors": true }],
    "not-rely-on-time": "warn",
    "reason-string": ["warn", { "maxLength": 64 }]
  }
}
```

### Foundry Scaffolding

```bash
forge init . --no-commit
forge install OpenZeppelin/openzeppelin-contracts
```

Create project structure:
```
src/
  interfaces/
  libraries/
test/
  unit/
  integration/
  mocks/
script/
foundry.toml
```

### Common Setup

1. Configure Solidity compiler version in the framework config
2. Set up remappings for imports (Foundry: `remappings.txt`, Hardhat: paths in config)
3. Create an initial `.gitignore` with `node_modules/`, `artifacts/`, `cache/`, `out/`, `lib/` (as appropriate)
4. Create initial git commit:
   ```bash
   git init
   git add -A
   git commit -m "chore: initial scaffold from bober.solidity"
   ```
5. Verify the scaffold compiles:
   ```bash
   npx hardhat compile   # or: forge build
   ```

## Step 4: Plan the Feature

Run the full planning workflow with Solidity-specific enhancements:

### Contract Architecture Planning

When planning a smart contract feature, consider:

1. **State variables:** What data does the contract store? What are the types? Storage layout matters for upgradeable contracts.
2. **Functions:** What are the external/public functions? What are the access control requirements for each?
3. **Events:** What events should be emitted for off-chain indexing?
4. **Errors:** Custom errors (gas-efficient) vs require strings?
5. **Modifiers:** What reusable checks are needed?
6. **Inheritance:** What base contracts to inherit from (OpenZeppelin, custom)?
7. **Interfaces:** Define interfaces first for clean architecture and testing.
8. **Upgrade patterns:** If upgradeable, plan storage layout carefully (no storage collisions).

### Solidity-Specific Sprint Ordering

For a typical smart contract feature:

1. **Interface and type definitions first:** Define the contract interface (`.sol` interface file), custom errors, events, and structs. This establishes the contract's API before implementation.
2. **Core contract logic:** Implement the main contract with state variables, constructor, and core functions. Inherit from base contracts (OpenZeppelin).
3. **Access control and modifiers:** Implement role-based access, pausability, and custom modifiers.
4. **Integration points:** Cross-contract calls (CPI), oracle integrations, DEX interactions.
5. **Testing:** Unit tests for every function, edge case tests, access control tests, gas benchmarks.
6. **Deployment and verification:** Deploy scripts, constructor argument encoding, Etherscan verification.

### Solidity-Specific Success Criteria

Include these for every contract sprint:

- "The contract compiles without errors or warnings using solc"
- "All functions have correct visibility modifiers (no unintended public functions)"
- "All state-changing functions emit appropriate events"
- "Access control is enforced: only authorized roles can call restricted functions"
- "Custom errors are used instead of require strings for gas efficiency"
- "All external/public functions have NatSpec documentation (@dev, @param, @return)"
- "Tests achieve 100% line coverage for new contract code"
- "No reentrancy vulnerabilities: state changes happen before external calls, or ReentrancyGuard is used"

### Solidity-Specific Evaluator Notes

- For compilation criteria, run the configured build command and check for zero errors and zero warnings
- For linting criteria, run solhint and check for zero errors
- For test criteria, run the test suite and verify all tests pass with expected coverage
- For security criteria, check for common vulnerability patterns (see Security Checklist below)
- For gas criteria, check that gas usage for key functions is within reasonable bounds

## Step 5: Execute the Pipeline

Run the full sprint execution loop with Solidity-specific evaluation:

### Solidity-Specific Evaluation Enhancements

When evaluating Solidity sprints, the evaluator should additionally check:

1. **Compilation:**
   - Zero compiler errors
   - Zero compiler warnings (treat warnings as errors)
   - Correct Solidity version pragma

2. **Security patterns:**
   - **Reentrancy:** State changes before external calls, or `ReentrancyGuard` used on functions that make external calls
   - **Access control:** No unprotected admin functions, proper role checks
   - **Integer safety:** Solidity 0.8+ has built-in overflow protection, but check for unchecked blocks
   - **Front-running:** Identify functions vulnerable to front-running (approve/transferFrom, DEX swaps)
   - **Oracle manipulation:** If using oracles, check for TWAP vs spot price, staleness checks
   - **Denial of service:** No unbounded loops over user-controlled arrays
   - **Flash loan attacks:** If DeFi, check for single-transaction price manipulation vectors
   - **Signature replay:** If using signatures, check for nonce/deadline/chainId protection

3. **Gas optimization:**
   - Use `uint256` instead of smaller types when storage packing is not achieved
   - Use `calldata` instead of `memory` for read-only function parameters
   - Pack storage variables (variables less than 32 bytes adjacent in storage)
   - Use custom errors instead of require strings
   - Mark functions as `view`/`pure` where applicable
   - Avoid redundant SLOAD operations (cache storage reads in memory)

4. **Code quality:**
   - NatSpec documentation on all external/public functions
   - Consistent naming: `_internalFunctions`, `CONSTANTS`, `storageVariables`
   - Events emitted for all state changes
   - Interface defined for cross-contract interactions
   - Proper use of `immutable` and `constant` keywords

5. **Test quality:**
   - Unit tests for every external/public function
   - Tests for access control (verify unauthorized calls revert)
   - Tests for edge cases (zero values, max values, empty arrays)
   - Tests for event emissions
   - Fuzz tests for arithmetic-heavy functions (Foundry)

## Step 6: Post-Pipeline Verification

After all sprints pass, run a final comprehensive check:

1. **Full compilation:**
   ```bash
   npx hardhat compile   # or: forge build
   ```

2. **Full test suite with coverage:**
   ```bash
   npx hardhat coverage   # or: forge coverage
   ```

3. **Linting:**
   ```bash
   npx solhint 'contracts/**/*.sol'   # or: npx solhint 'src/**/*.sol'
   ```

4. **Gas report:**
   ```bash
   REPORT_GAS=true npx hardhat test   # or: forge test --gas-report
   ```

5. **Report to user:**
   ```
   ## Smart Contracts Complete

   Your contracts are ready for review.

   ### How to Build & Test
   npx hardhat compile     # Compile contracts
   npx hardhat test        # Run tests
   npx hardhat coverage    # Coverage report

   ### What Was Built
   <Summary of contracts implemented>

   ### Contract Architecture
   <Inheritance diagram, key contracts and their roles>

   ### Security Notes
   <Key security decisions made, patterns applied>

   ### Deployment
   <Instructions for deploying to testnet/mainnet>

   ### Next Steps
   - Review the contracts on branch: bober/<feature-slug>
   - Run a professional audit before mainnet deployment
   - Deploy to testnet first: npx hardhat run scripts/deploy.ts --network sepolia
   - Verify on Etherscan after deployment
   ```

## Security Checklist

The evaluator MUST check for these common vulnerability patterns:

1. **Reentrancy:** External calls made before state updates. Mitigate with checks-effects-interactions pattern or `ReentrancyGuard`.
2. **Front-running:** Transactions that can be profitably front-run (approve, swaps). Mitigate with commit-reveal, deadlines, or slippage protection.
3. **Oracle manipulation:** Single-block price reads. Mitigate with TWAP, multiple oracle sources, or circuit breakers.
4. **Integer overflow/underflow:** Unchecked arithmetic blocks. Mitigate by avoiding `unchecked` unless gas-critical and mathematically proven safe.
5. **Access control:** Missing or incorrect role checks. Mitigate with OpenZeppelin AccessControl or Ownable.
6. **Denial of service:** Unbounded loops, block gas limit issues. Mitigate with pagination, pull-over-push patterns.
7. **Signature replay:** Missing nonce, deadline, or chain ID in signed messages. Mitigate with EIP-712 typed data.
8. **Centralization risks:** Single admin key controlling critical functions. Mitigate with multisig, timelock, or governance.
9. **Storage collisions:** In upgradeable contracts, storage layout changes between versions. Mitigate with storage gaps, ERC-7201 namespaced storage.
10. **Unchecked return values:** Not checking return values of `transfer`, `approve`, or low-level calls. Mitigate with SafeERC20 or explicit checks.

## Next Steps

After completing this phase, suggest the following next steps to the user:
- `/bober-plan` — Plan the smart contract feature

## Error Handling

- **Compilation failures:** Read the compiler output carefully. Common issues: import path errors, version mismatches, missing dependencies. Run `forge install` or `npm install` first.
- **Test failures in Hardhat:** Check that the local Hardhat node is not already running on the same port. Check that test fixtures deploy contracts correctly.
- **Test failures in Foundry:** Check that `setUp()` deploys all required contracts. Check that fork tests have the correct RPC URL configured.
- **Solhint errors:** If solhint is not installed, install it as a dev dependency. If rules are too strict, adjust `.solhint.json` but document the reason.
- **Gas report issues:** If gas reports show unexpectedly high usage, flag specific functions for optimization in a follow-up sprint.
