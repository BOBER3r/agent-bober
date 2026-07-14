---
name: bober.security-solidity
description: "Solidity/EVM smart-contract security signature library. Not a workflow skill -- a data file of discrete vulnerable/safe code signature blocks read by SecuritySignatureParser. Covers reentrancy (single-function, cross-function, read-only), spot-price oracle manipulation, missing access control, unprotected initializers, unchecked arithmetic, ERC-4626 inflation, unsafe ERC20, tx.origin auth, missing slippage/deadline, DoS via unbounded loops, and signature replay."
---

# bober.security-solidity — Solidity/EVM Security Signature Library

This skill is a **signature-library** file, not a workflow skill. It is read (as raw
markdown text) by `SecuritySignatureParser.parse()`
(`src/orchestrator/security-knowledge/parser.ts`) and turned into typed
`SecuritySignature[]` records used by the security-audit agent team. Do not confuse this
with `bober.solidity`, which is the general Solidity development skill, or
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

### solidity.reentrancy-single-function
- **Title:** Single-function reentrancy: external call before state update
- **CWE:** SWC-107
- **Severity:** critical
- **VulnClass:** race-condition
- **Invariant:** All state that a function depends on is finalized (checks-effects-interactions) before any external call that could re-enter the same function.
- **Keywords:** reentrancy, call, checks-effects-interactions, nonReentrant

**Unsafe:**
```ts
(bool ok, ) = msg.sender.call{value: balances[msg.sender]}("");
require(ok);
balances[msg.sender] = 0;
```

**Safe:**
```ts
uint256 amount = balances[msg.sender];
balances[msg.sender] = 0;
(bool ok, ) = msg.sender.call{value: amount}("");
require(ok);
```

### solidity.reentrancy-readonly
- **Title:** Read-only reentrancy via view function during callback
- **CWE:** SWC-107
- **Severity:** high
- **VulnClass:** race-condition
- **Invariant:** A view function's return value must never be trusted mid-callback while a caller's external hook (e.g. an ERC777/ERC721 receiver hook) can still mutate the same pool state.
- **Keywords:** read-only reentrancy, view, getReserves, callback

**Unsafe:**
```ts
function price() external view returns (uint256) {
  (uint112 r0, uint112 r1, ) = pair.getReserves(); // stale mid-callback
  return r1 * 1e18 / r0;
}
```

**Safe:**
```ts
function price() external view returns (uint256) {
  require(!pair.locked(), "reentrant read"); // reentrancy-guard-aware getter
  (uint112 r0, uint112 r1, ) = pair.getReserves();
  return r1 * 1e18 / r0;
}
```

### solidity.spot-price-oracle-flashloan
- **Title:** Spot AMM price used as oracle (flash-loan manipulable)
- **Severity:** critical
- **VulnClass:** money-integrity
- **Invariant:** A price used for liquidation/collateral/settlement math is never a single-block spot reserve ratio — it comes from a manipulation-resistant source with a staleness bound.
- **Keywords:** oracle, spot price, getReserves, TWAP, flash loan

**Unsafe:**
```ts
(uint112 r0, uint112 r1, ) = pair.getReserves();
uint256 price = r1 * 1e18 / r0; // manipulable within one flash-loaned tx
```

**Safe:**
```ts
uint256 price = chainlinkFeed.latestAnswer();
require(block.timestamp - chainlinkFeed.updatedAt() < MAX_STALENESS, "stale price");
```

### solidity.missing-onlyowner
- **Title:** Missing onlyOwner/role modifier on a privileged function
- **CWE:** SWC-105
- **Severity:** critical
- **VulnClass:** authn-authz
- **Invariant:** Every function that mutates protocol-critical state (fees, admin addresses, pausing, minting) is gated by an explicit ownership or role check.
- **Keywords:** onlyOwner, AccessControl, modifier, privileged

**Unsafe:**
```ts
function setFee(uint256 newFee) public {
  fee = newFee; // callable by anyone
}
```

**Safe:**
```ts
function setFee(uint256 newFee) public onlyRole(FEE_ADMIN_ROLE) {
  fee = newFee;
}
```

### solidity.unprotected-initializer
- **Title:** Unprotected initializer / uninitialized proxy implementation (Parity-style)
- **CWE:** CWE-665
- **Severity:** critical
- **VulnClass:** privilege-escalation
- **Invariant:** An upgradeable contract's `initialize()` can only ever run once, and the logic-contract instance itself is never left in an initializable state.
- **Keywords:** initializer, initialize, proxy, _disableInitializers

**Unsafe:**
```ts
function initialize(address _owner) public {
  owner = _owner; // callable repeatedly by anyone on the implementation contract
}
```

**Safe:**
```ts
constructor() { _disableInitializers(); }

function initialize(address _owner) public initializer {
  owner = _owner;
}
```

### solidity.unchecked-arithmetic
- **Title:** unchecked{} block underflows a balance
- **CWE:** SWC-101
- **Severity:** critical
- **VulnClass:** money-integrity
- **Invariant:** A balance or supply subtraction never wraps — the subtrahend is bounds-checked before entering an unchecked block, or the block is dropped in favor of checked arithmetic.
- **Keywords:** unchecked, overflow, underflow, arithmetic

**Unsafe:**
```ts
unchecked {
  balances[msg.sender] -= amount; // wraps to a huge balance if amount > balance
}
```

**Safe:**
```ts
require(balances[msg.sender] >= amount, "insufficient balance");
balances[msg.sender] -= amount;
```

### solidity.erc4626-inflation
- **Title:** ERC-4626 first-depositor / share-inflation attack
- **Severity:** critical
- **VulnClass:** money-integrity
- **Invariant:** Share-price math (assets-per-share) can never be driven to an attacker-favorable rounding extreme by a first depositor donating raw assets directly to the vault.
- **Keywords:** ERC4626, first depositor, inflation, virtual shares, dead shares

**Unsafe:**
```ts
function deposit(uint256 assets) external returns (uint256 shares) {
  shares = totalSupply == 0 ? assets : assets * totalSupply / totalAssets();
  _mint(msg.sender, shares); // attacker mints 1 share then donates assets to inflate price
}
```

**Safe:**
```ts
function deposit(uint256 assets) external returns (uint256 shares) {
  shares = assets * (totalSupply + 10 ** decimalsOffset) / (totalAssets() + 1); // virtual shares/assets offset
  _mint(msg.sender, shares);
}
```

### solidity.unsafe-erc20
- **Title:** Unsafe ERC20 usage (no SafeERC20 / fee-on-transfer / rebasing)
- **CWE:** SWC-104
- **Severity:** high
- **VulnClass:** money-integrity
- **Invariant:** Every ERC20 transfer's return value is checked, and any accounting derived from a transfer uses the measured balance delta, not the nominal amount passed in.
- **Keywords:** transfer, SafeERC20, fee-on-transfer, rebasing, return value

**Unsafe:**
```ts
token.transfer(recipient, amount); // return value ignored; assumes amount fully received
credited[recipient] += amount;
```

**Safe:**
```ts
uint256 before = token.balanceOf(address(this));
token.safeTransfer(recipient, amount);
uint256 received = before - token.balanceOf(address(this));
credited[recipient] += received;
```

### solidity.txorigin-auth
- **Title:** tx.origin used for authorization (phishable)
- **CWE:** SWC-115
- **Severity:** high
- **VulnClass:** authn-authz
- **Invariant:** Authorization checks compare against `msg.sender`, never `tx.origin`, so a malicious intermediate contract cannot impersonate the original caller.
- **Keywords:** tx.origin, msg.sender, phishing

**Unsafe:**
```ts
function withdraw() external {
  require(tx.origin == owner); // phishable via a malicious contract the owner interacts with
  payable(owner).transfer(address(this).balance);
}
```

**Safe:**
```ts
function withdraw() external {
  require(msg.sender == owner);
  payable(owner).transfer(address(this).balance);
}
```

### solidity.missing-slippage-deadline
- **Title:** Swap missing amountOutMin / deadline (sandwich-attack surface)
- **Severity:** high
- **VulnClass:** money-integrity
- **Invariant:** Every swap specifies a caller-supplied minimum output and a real expiry deadline, so a sandwiching attacker cannot extract unbounded slippage.
- **Keywords:** amountOutMin, deadline, slippage, swap, sandwich

**Unsafe:**
```ts
router.swapExactTokensForTokens(amountIn, 0, path, msg.sender, block.timestamp);
```

**Safe:**
```ts
router.swapExactTokensForTokens(amountIn, minAmountOut, path, msg.sender, userSuppliedDeadline);
```

### solidity.dos-unbounded-loop
- **Title:** DoS via unbounded loop over a growable array
- **CWE:** SWC-128
- **Severity:** high
- **VulnClass:** denial-of-service
- **Invariant:** No externally-triggerable function iterates over a collection whose size is controlled by untrusted users within a single transaction's gas budget.
- **Keywords:** unbounded loop, gas limit, pull-over-push, DoS

**Unsafe:**
```ts
function distribute() external {
  for (uint256 i = 0; i < holders.length; i++) { // holders.length grows unbounded
    payable(holders[i]).transfer(shares[holders[i]]);
  }
}
```

**Safe:**
```ts
function claim() external { // pull-over-push, one holder per call, bounded gas
  uint256 amount = shares[msg.sender];
  shares[msg.sender] = 0;
  payable(msg.sender).transfer(amount);
}
```

### solidity.signature-replay
- **Title:** Missing nonce/chainId/EIP-712 domain; ecrecover==0 malleability
- **CWE:** SWC-117
- **Severity:** critical
- **VulnClass:** crypto-weakness
- **Invariant:** A recovered signer address is checked against the zero address, and the signed payload binds a single-use nonce, the chain id, and an EIP-712 domain so a signature cannot be replayed across calls or chains.
- **Keywords:** ecrecover, nonce, chainId, EIP-712, replay, malleability

**Unsafe:**
```ts
address signer = ecrecover(hash, v, r, s); // no domain, no nonce, no zero-address check
require(signer == expectedSigner);
```

**Safe:**
```ts
bytes32 digest = _hashTypedDataV4(structHash); // EIP-712 domain-bound, includes nonce + chainId
address signer = ecrecover(digest, v, r, s);
require(signer != address(0) && signer == expectedSigner);
require(!usedNonces[nonce]);
usedNonces[nonce] = true;
```
