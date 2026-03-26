# Solidity Project Guide

## Architecture

This is an EVM smart contract project using Hardhat (or Foundry).

```
contracts/            Solidity source files
  interfaces/         Interface definitions
  libraries/          Shared library contracts
test/                 Test files (Chai/Mocha for Hardhat, Forge tests for Foundry)
scripts/              Deployment and utility scripts
hardhat.config.ts     Hardhat configuration
```

## Hardhat Setup

```bash
npx hardhat compile           # compile all contracts
npx hardhat test              # run the test suite
npx hardhat test --grep "transfer"  # run tests matching a pattern
npx hardhat node              # start a local Hardhat node
npx hardhat run scripts/deploy.ts --network localhost  # deploy locally
```

If using Foundry alongside Hardhat:

```bash
forge build                   # compile with Foundry
forge test                    # run Foundry tests
forge test -vvv               # run with verbose output (traces)
```

## Contract Structure

- Each contract goes in its own file under `contracts/`.
- Use a consistent naming convention: `ContractName.sol` matches the contract name inside.
- Inherit from OpenZeppelin contracts where possible instead of reimplementing standard functionality.
- Define interfaces in `contracts/interfaces/` and implement them in concrete contracts.

## OpenZeppelin Usage

- Import OpenZeppelin contracts from `@openzeppelin/contracts`.
- Common imports: `ERC20`, `ERC721`, `ERC1155`, `Ownable`, `AccessControl`, `ReentrancyGuard`, `Pausable`.
- For upgradeable contracts, use `@openzeppelin/contracts-upgradeable` and initialize in an `initialize()` function instead of a constructor.

## Testing

- Write tests in TypeScript using Chai assertions and Mocha structure (`describe`, `it`).
- Use `ethers.getSigners()` to get test accounts.
- Use `loadFixture` from `@nomicfoundation/hardhat-toolbox` to snapshot and revert state between tests.
- Test all success paths, revert conditions, event emissions, and edge cases.
- Use `expect(...).to.be.revertedWith("message")` or `revertedWithCustomError` for revert testing.

```typescript
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";

describe("MyContract", function () {
  async function deployFixture() {
    const [owner, other] = await hre.ethers.getSigners();
    const MyContract = await hre.ethers.getContractFactory("MyContract");
    const contract = await MyContract.deploy();
    return { contract, owner, other };
  }

  it("should do something", async function () {
    const { contract, owner } = await loadFixture(deployFixture);
    expect(await contract.owner()).to.equal(owner.address);
  });
});
```

## Deployment Scripts

- Place deployment scripts in `scripts/`.
- Use `hardhat-deploy` plugin or write custom scripts with `ethers`.
- Always verify contracts on block explorers after deployment.

## Gas Optimization

- Use `uint256` instead of smaller uint types unless packing structs.
- Prefer `calldata` over `memory` for external function parameters that are read-only.
- Use `immutable` for variables set once in the constructor.
- Use `constant` for compile-time constants.
- Minimize storage writes (SSTORE is the most expensive opcode).
- Use events for data that does not need on-chain reads.
- Batch operations where possible to amortize base transaction costs.

## Security Patterns

- **Reentrancy**: Use `ReentrancyGuard` or follow checks-effects-interactions pattern.
- **Overflow/Underflow**: Solidity 0.8+ has built-in overflow checks. Be careful with `unchecked` blocks.
- **Access Control**: Use `Ownable` for simple ownership or `AccessControl` for role-based permissions.
- **Input Validation**: Validate all external inputs with `require` statements at the top of functions.
- **Frontrunning**: Consider commit-reveal schemes or use flashbots for sensitive transactions.
- **Upgradability**: If using proxies, follow the UUPS or Transparent Proxy pattern. Never leave an implementation uninitialized.

## Linting

```bash
npx solhint 'contracts/**/*.sol'    # lint Solidity files
```

Configure rules in `.solhint.json`. Recommended rules: `compiler-version`, `no-unused-vars`, `reason-string`, `func-visibility`.
