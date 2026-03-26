# Solidity Development Reference Guide

## Hardhat vs Foundry Project Structure

### Hardhat Project Structure

```
project-root/
  contracts/           # Solidity source files
    interfaces/        # Contract interfaces
    libraries/         # Shared libraries
    mocks/             # Mock contracts for testing
    MyContract.sol
  test/                # Test files (TypeScript/JavaScript)
    unit/              # Unit tests
    integration/       # Integration tests
    helpers/           # Test utilities and fixtures
  scripts/             # Deployment and utility scripts
    deploy/
  artifacts/           # Compiled contract artifacts (generated)
  cache/               # Hardhat cache (generated)
  typechain-types/     # TypeScript bindings (generated)
  hardhat.config.ts    # Hardhat configuration
  .solhint.json        # Solhint linter configuration
  package.json
  tsconfig.json
```

**Key config (`hardhat.config.ts`):**
```typescript
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: false,
    },
  },
  networks: {
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "",
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },
};

export default config;
```

### Foundry Project Structure

```
project-root/
  src/                 # Solidity source files
    interfaces/
    libraries/
    MyContract.sol
  test/                # Solidity test files
    unit/
    integration/
    mocks/
  script/              # Deployment scripts (Solidity)
  lib/                 # Installed dependencies (git submodules)
    forge-std/
    openzeppelin-contracts/
  out/                 # Compiled artifacts (generated)
  cache/               # Foundry cache (generated)
  foundry.toml         # Foundry configuration
  remappings.txt       # Import remappings
```

**Key config (`foundry.toml`):**
```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc_version = "0.8.24"
optimizer = true
optimizer_runs = 200
via_ir = false

[profile.default.fuzz]
runs = 256
max_test_rejects = 65536

[rpc_endpoints]
sepolia = "${SEPOLIA_RPC_URL}"
mainnet = "${MAINNET_RPC_URL}"

[etherscan]
sepolia = { key = "${ETHERSCAN_API_KEY}" }
mainnet = { key = "${ETHERSCAN_API_KEY}" }
```

## Common Contract Patterns

### ERC-20 Token

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract MyToken is ERC20, ERC20Burnable, ERC20Permit, Ownable {
    constructor(address initialOwner)
        ERC20("MyToken", "MTK")
        ERC20Permit("MyToken")
        Ownable(initialOwner)
    {
        _mint(initialOwner, 1_000_000 * 10 ** decimals());
    }

    function mint(address to, uint256 amount) public onlyOwner {
        _mint(to, amount);
    }
}
```

### ERC-721 NFT

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract MyNFT is ERC721, ERC721URIStorage, Ownable {
    uint256 private _nextTokenId;

    constructor(address initialOwner)
        ERC721("MyNFT", "MNFT")
        Ownable(initialOwner)
    {}

    function safeMint(address to, string memory uri) public onlyOwner {
        uint256 tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
        _setTokenURI(tokenId, uri);
    }

    // Required overrides
    function tokenURI(uint256 tokenId)
        public view override(ERC721, ERC721URIStorage) returns (string memory)
    {
        return super.tokenURI(tokenId);
    }

    function supportsInterface(bytes4 interfaceId)
        public view override(ERC721, ERC721URIStorage) returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
```

### ERC-1155 Multi-Token

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

contract MyMultiToken is ERC1155, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    constructor(address admin) ERC1155("https://api.example.com/metadata/{id}.json") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MINTER_ROLE, admin);
    }

    function mint(address to, uint256 id, uint256 amount, bytes memory data)
        public onlyRole(MINTER_ROLE)
    {
        _mint(to, id, amount, data);
    }

    function supportsInterface(bytes4 interfaceId)
        public view override(ERC1155, AccessControl) returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
```

### Governor (DAO Governance)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Governor} from "@openzeppelin/contracts/governance/Governor.sol";
import {GovernorSettings} from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import {GovernorCountingSimple} from "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import {GovernorVotes} from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import {GovernorVotesQuorumFraction} from "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import {GovernorTimelockControl} from "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

contract MyGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorTimelockControl
{
    constructor(IVotes _token, TimelockController _timelock)
        Governor("MyGovernor")
        GovernorSettings(7200 /* 1 day */, 50400 /* 1 week */, 0)
        GovernorVotes(_token)
        GovernorVotesQuorumFraction(4)
        GovernorTimelockControl(_timelock)
    {}

    // Required overrides omitted for brevity
}
```

### Timelock Controller

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

contract MyTimelock is TimelockController {
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {}
}
```

## Testing Patterns

### Hardhat Testing (TypeScript)

```typescript
import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

describe("MyToken", function () {
  async function deployFixture() {
    const [owner, addr1, addr2] = await ethers.getSigners();
    const MyToken = await ethers.getContractFactory("MyToken");
    const token = await MyToken.deploy(owner.address);
    return { token, owner, addr1, addr2 };
  }

  describe("Deployment", function () {
    it("should set the right owner", async function () {
      const { token, owner } = await loadFixture(deployFixture);
      expect(await token.owner()).to.equal(owner.address);
    });

    it("should assign the total supply to the owner", async function () {
      const { token, owner } = await loadFixture(deployFixture);
      const ownerBalance = await token.balanceOf(owner.address);
      expect(await token.totalSupply()).to.equal(ownerBalance);
    });
  });

  describe("Transfers", function () {
    it("should transfer tokens between accounts", async function () {
      const { token, owner, addr1, addr2 } = await loadFixture(deployFixture);
      await expect(token.transfer(addr1.address, 50))
        .to.changeTokenBalances(token, [owner, addr1], [-50, 50]);
    });

    it("should emit Transfer event", async function () {
      const { token, owner, addr1 } = await loadFixture(deployFixture);
      await expect(token.transfer(addr1.address, 50))
        .to.emit(token, "Transfer")
        .withArgs(owner.address, addr1.address, 50);
    });

    it("should revert when sender has insufficient balance", async function () {
      const { token, addr1, addr2 } = await loadFixture(deployFixture);
      await expect(token.connect(addr1).transfer(addr2.address, 1))
        .to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");
    });
  });

  describe("Access Control", function () {
    it("should only allow owner to mint", async function () {
      const { token, addr1 } = await loadFixture(deployFixture);
      await expect(token.connect(addr1).mint(addr1.address, 100))
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount");
    });
  });
});
```

### Foundry Testing (Solidity)

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console2} from "forge-std/Test.sol";
import {MyToken} from "../src/MyToken.sol";

contract MyTokenTest is Test {
    MyToken public token;
    address public owner;
    address public addr1;
    address public addr2;

    function setUp() public {
        owner = makeAddr("owner");
        addr1 = makeAddr("addr1");
        addr2 = makeAddr("addr2");

        vm.prank(owner);
        token = new MyToken(owner);
    }

    function test_OwnerIsSetCorrectly() public view {
        assertEq(token.owner(), owner);
    }

    function test_TotalSupplyAssignedToOwner() public view {
        assertEq(token.balanceOf(owner), token.totalSupply());
    }

    function test_Transfer() public {
        vm.prank(owner);
        token.transfer(addr1, 50);
        assertEq(token.balanceOf(addr1), 50);
    }

    function test_RevertWhen_InsufficientBalance() public {
        vm.prank(addr1);
        vm.expectRevert();
        token.transfer(addr2, 1);
    }

    function test_RevertWhen_NonOwnerMints() public {
        vm.prank(addr1);
        vm.expectRevert();
        token.mint(addr1, 100);
    }

    // Fuzz test example
    function testFuzz_Transfer(uint256 amount) public {
        amount = bound(amount, 0, token.balanceOf(owner));
        vm.prank(owner);
        token.transfer(addr1, amount);
        assertEq(token.balanceOf(addr1), amount);
    }
}
```

## Deployment and Verification Workflow

### Hardhat Deployment

```typescript
// scripts/deploy.ts
import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const MyToken = await ethers.getContractFactory("MyToken");
  const token = await MyToken.deploy(deployer.address);
  await token.waitForDeployment();

  const address = await token.getAddress();
  console.log("MyToken deployed to:", address);

  // Wait for block confirmations before verifying
  console.log("Waiting for confirmations...");
  await token.deploymentTransaction()?.wait(5);

  // Verify on Etherscan
  console.log("Verifying on Etherscan...");
  await hre.run("verify:verify", {
    address: address,
    constructorArguments: [deployer.address],
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

### Foundry Deployment

```solidity
// script/Deploy.s.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console2} from "forge-std/Script.sol";
import {MyToken} from "../src/MyToken.sol";

contract DeployScript is Script {
    function run() public {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerPrivateKey);

        vm.startBroadcast(deployerPrivateKey);
        MyToken token = new MyToken(deployer);
        vm.stopBroadcast();

        console2.log("MyToken deployed to:", address(token));
    }
}
```

```bash
# Deploy with Foundry
forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast --verify
```

### Verification

```bash
# Hardhat
npx hardhat verify --network sepolia <CONTRACT_ADDRESS> <CONSTRUCTOR_ARGS>

# Foundry (automatic with --verify flag during deployment)
forge verify-contract <CONTRACT_ADDRESS> MyToken --chain sepolia
```

## Security Checklist

Before considering a contract ready for deployment:

### Critical

- [ ] No reentrancy vulnerabilities (checks-effects-interactions or ReentrancyGuard)
- [ ] All external/public functions have appropriate access control
- [ ] No unchecked external call return values (use SafeERC20 for token transfers)
- [ ] Integer arithmetic is safe (Solidity 0.8+ default, check unchecked blocks)
- [ ] No delegatecall to untrusted contracts
- [ ] Upgradeable contracts have proper storage gaps and initializers

### High Priority

- [ ] Front-running protection where needed (commit-reveal, deadlines)
- [ ] Oracle data has staleness checks and fallback mechanisms
- [ ] No unbounded loops that could hit block gas limit
- [ ] Signature replay protection (nonces, deadlines, chain ID via EIP-712)
- [ ] Proper event emissions for all state changes
- [ ] Constructor/initializer sets all critical state variables

### Medium Priority

- [ ] Gas optimization: storage packing, calldata usage, view/pure modifiers
- [ ] NatSpec documentation on all public interfaces
- [ ] Consistent error handling (custom errors preferred over require strings)
- [ ] Immutable and constant keywords used where applicable
- [ ] No floating pragma (use exact version: `pragma solidity 0.8.24;`)

### Pre-Mainnet

- [ ] Professional audit completed
- [ ] Testnet deployment tested end-to-end
- [ ] Deployment scripts tested on forked mainnet
- [ ] Emergency pause mechanism if appropriate
- [ ] Admin key management plan (multisig, timelock)
- [ ] Monitoring and alerting set up for critical events
