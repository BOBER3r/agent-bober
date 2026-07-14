---
name: bober.security-dex-backend
description: "Crypto exchange/DEX off-chain backend security signature library. Not a workflow skill -- a data file of discrete vulnerable/safe code signature blocks read by SecuritySignatureParser. Covers withdrawal TOCTOU races, missing withdrawal idempotency, missing 2FA/withdrawal-whitelist cooldown, deposit crediting without confirmations, token decimals mismatch, float token amounts, hot-wallet key custody, KMS signer authz gates, SIWE replay, missing price-feed circuit breakers, unsigned webhooks, and unvalidated withdrawal amounts."
---

# bober.security-dex-backend — Crypto Exchange/DEX Off-Chain Backend Security Signature Library

This skill is a **signature-library** file, not a workflow skill. It is read (as raw
markdown text) by `SecuritySignatureParser.parse()`
(`src/orchestrator/security-knowledge/parser.ts`) and turned into typed
`SecuritySignature[]` records used by the security-audit agent team. Do not confuse this
with `bober.security-audit`, which is the audit *workflow* skill. This skill covers the
off-chain custody/backend surface of an exchange or DEX — where most exchange money is
actually stolen — as distinct from `bober.security-solidity`'s on-chain contract surface.

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

### dex.withdrawal-toctou-race
- **Title:** Withdrawal TOCTOU race (SELECT-compare-UPDATE, no row lock)
- **CWE:** CWE-362
- **Severity:** critical
- **VulnClass:** race-condition
- **Invariant:** A withdrawal debit is a single atomic conditional write against the balance — never a separate SELECT-then-UPDATE that lets two concurrent requests both pass the check.
- **Keywords:** withdrawal, FOR UPDATE, row lock, TOCTOU, balance

**Unsafe:**
```ts
const { balance } = await db.query("SELECT balance FROM wallets WHERE id = $1", [id]);
if (balance >= amount) await db.query("UPDATE wallets SET balance = balance - $1 WHERE id = $2", [amount, id]);
```

**Safe:**
```ts
const result = await db.query(
  "UPDATE wallets SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance",
  [amount, id],
);
if (result.rowCount === 0) throw new Error("insufficient balance");
```

### dex.missing-withdrawal-idempotency
- **Title:** Missing withdrawal idempotency key (double-withdraw on client retry)
- **CWE:** CWE-362
- **Severity:** critical
- **VulnClass:** race-condition
- **Invariant:** A withdrawal request carries a unique client idempotency key enforced with a database uniqueness constraint, so a retried request cannot execute the withdrawal twice.
- **Keywords:** idempotency, withdrawal, unique, retry, double-withdraw

**Unsafe:**
```ts
app.post("/withdraw", async (req, res) => { await executeWithdrawal(req.body.amount, req.body.address); });
```

**Safe:**
```ts
app.post("/withdraw", async (req, res) => {
  const inserted = await db.query(
    "INSERT INTO withdrawal_requests (idempotency_key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING idempotency_key",
    [req.headers["idempotency-key"]],
  );
  if (inserted.rowCount === 0) return res.status(409).json({ error: "duplicate request" });
  await executeWithdrawal(req.body.amount, req.body.address);
});
```

### dex.missing-2fa-cooldown
- **Title:** Missing 2FA / withdrawal-whitelist cooldown (Crypto.com-style bypass)
- **Severity:** critical
- **VulnClass:** authn-authz
- **Invariant:** A withdrawal to a new destination address requires a fresh second-factor confirmation and is held for a cooldown window before it becomes eligible to execute, unless the address is already on an established allowlist.
- **Keywords:** 2FA, withdrawal whitelist, cooldown, allowlist, address-book

**Unsafe:**
```ts
await executeWithdrawal(userId, amount, newAddress); // instant withdrawal to any address, no 2FA re-check
```

**Safe:**
```ts
await assert2faVerified(userId, req.body.totpCode);
if (!(await isWhitelistedAddress(userId, newAddress))) {
  await queueForCooldown(userId, newAddress, amount, WITHDRAWAL_COOLDOWN_MS); // held before executing
  return;
}
await executeWithdrawal(userId, amount, newAddress);
```

### dex.deposit-no-confirmations
- **Title:** Deposit credited off event-log/webhook without outer-tx-success + balanceOf delta + confirmations
- **CWE:** CWE-345
- **Severity:** critical
- **VulnClass:** money-integrity
- **Invariant:** A deposit is only credited after the containing transaction's receipt reports success, the credited amount matches a measured balanceOf delta, and the block has accumulated the required confirmation depth.
- **Keywords:** deposit, confirmations, balanceOf, reorg, receipt.status

**Unsafe:**
```ts
provider.on(transferFilter, (from, to, amount) => { creditDeposit(to, amount); }); // credited on log alone, no confirmation wait
```

**Safe:**
```ts
provider.on(transferFilter, async (from, to, amount, event) => {
  const receipt = await event.getTransactionReceipt();
  if (receipt.status !== 1) return;
  const confirmations = await event.getBlockNumber().then((bn) => provider.getBlockNumber().then((cur) => cur - bn));
  if (confirmations < REQUIRED_CONFIRMATIONS) return;
  const delta = await measureBalanceOfDelta(to, event.blockNumber);
  creditDeposit(to, delta);
});
```

### dex.token-decimals-mismatch
- **Title:** Token decimals mismatch (WBTC=8, USDC=6 vs assumed 18)
- **CWE:** CWE-682
- **Severity:** critical
- **VulnClass:** money-integrity
- **Invariant:** Every raw on-chain token amount is converted using that specific token's actual `decimals()` value, never a hardcoded assumption of 18.
- **Keywords:** decimals, WBTC, USDC, parseUnits, 10^18

**Unsafe:**
```ts
const humanAmount = Number(rawAmount) / 1e18; // wrong for USDC (6) and WBTC (8)
```

**Safe:**
```ts
const decimals = await tokenContract.decimals();
const humanAmount = ethers.formatUnits(rawAmount, decimals);
```

### dex.float-token-amounts
- **Title:** Float/Number token amounts instead of BigInt
- **CWE:** CWE-681
- **Severity:** high
- **VulnClass:** money-integrity
- **Invariant:** On-chain token amounts are carried as BigInt (or an equivalent arbitrary-precision integer) end-to-end — never converted through a JS `Number`, which loses precision above 2^53.
- **Keywords:** BigInt, Number, float, wei, precision

**Unsafe:**
```ts
const amount = Number(rawWeiAmount); // loses precision for large wei values
await creditLedger(userId, amount);
```

**Safe:**
```ts
const amount = BigInt(rawWeiAmount);
await creditLedger(userId, amount);
```

### dex.hot-wallet-key-in-env
- **Title:** Hot-wallet private key in env/config/repo
- **CWE:** CWE-798
- **Severity:** critical
- **VulnClass:** secret-handling
- **Invariant:** A private key or seed phrase that can move customer funds is never a literal string in source, config, or a plaintext environment variable — it is held in a non-extractable form (KMS/HSM) that only signs on request.
- **Keywords:** private key, PRIVATE_KEY, hot wallet, env, mnemonic, seed phrase

**Unsafe:**
```ts
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY); // key material in plaintext env
```

**Safe:**
```ts
const signer = new KmsSigner(process.env.KMS_KEY_ID); // key never leaves the KMS/HSM boundary
```

### dex.kms-signer-no-authz-gate
- **Title:** KMS/HSM signer with no policy/authz gate in front
- **CWE:** CWE-862
- **Severity:** critical
- **VulnClass:** authn-authz
- **Invariant:** A call to the custody signer is only reachable after an explicit authorization policy (amount limits, destination allowlist, rate limit) approves the specific request — the signer is never directly callable by request handlers.
- **Keywords:** KMS, HSM, signer, policy gate, authorization, sign

**Unsafe:**
```ts
app.post("/withdraw", async (req, res) => {
  const sig = await kmsSigner.sign(req.body.tx); // any authenticated caller can get anything signed
  res.json({ sig });
});
```

**Safe:**
```ts
app.post("/withdraw", async (req, res) => {
  await assertWithinPolicy(req.body.tx, { maxAmount: DAILY_LIMIT, allowlist: destinationAllowlist });
  const sig = await kmsSigner.sign(req.body.tx);
  res.json({ sig });
});
```

### dex.siwe-replay
- **Title:** SIWE/EIP-4361 recover-but-skip-domain/nonce/chainId (replay)
- **CWE:** CWE-294
- **Severity:** critical
- **VulnClass:** crypto-weakness
- **Invariant:** A Sign-In-With-Ethereum message is only accepted after validating its domain, chain id, and a server-issued single-use nonce, and after checking the message has not expired — signature recovery alone is not authentication.
- **Keywords:** SIWE, EIP-4361, nonce, domain, chainId, verifyMessage, replay

**Unsafe:**
```ts
const recovered = ethers.verifyMessage(message, signature);
if (recovered === expectedAddress) req.session.userId = recovered; // domain/nonce/chainId never checked
```

**Safe:**
```ts
const siweMessage = new SiweMessage(message);
const { data } = await siweMessage.verify({ signature, domain, nonce: req.session.nonce });
if (data.chainId !== EXPECTED_CHAIN_ID || Date.parse(data.expirationTime) < Date.now()) throw new Error("invalid SIWE");
req.session.userId = data.address;
```

### dex.missing-price-circuit-breaker
- **Title:** Missing circuit breaker / sanity bound on price feed
- **Severity:** critical
- **VulnClass:** money-integrity
- **Invariant:** A price read from an external feed is rejected (and trading paused) when it deviates beyond a bounded threshold from the last accepted price or exceeds a staleness window, rather than being applied unconditionally.
- **Keywords:** circuit breaker, price feed, oracle, RPC, sanity, staleness

**Unsafe:**
```ts
const price = await priceFeed.getPrice(); // applied unconditionally, no deviation or staleness bound
applyPrice(price);
```

**Safe:**
```ts
const price = await priceFeed.getPrice();
const deviation = Math.abs(price - lastAcceptedPrice) / lastAcceptedPrice;
if (deviation > MAX_DEVIATION || priceFeed.staleness() > MAX_STALENESS_MS) {
  pauseTrading();
  return;
}
applyPrice(price);
```

### dex.webhook-no-signature
- **Title:** Provider/chain webhook accepted without signature verification
- **CWE:** CWE-345
- **Severity:** critical
- **VulnClass:** authn-authz
- **Invariant:** A chain-indexer or provider webhook payload is only processed after its signature header is verified against the provider's known signing secret.
- **Keywords:** webhook, signature, HMAC, provider callback, verify

**Unsafe:**
```ts
app.post("/chain-webhook", (req, res) => { processDepositEvent(req.body); }); // unsigned body trusted directly
```

**Safe:**
```ts
app.post("/chain-webhook", (req, res) => {
  const expected = crypto.createHmac("sha256", providerSecret).update(req.rawBody).digest("hex");
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-provider-signature"]))) {
    return res.status(401).end();
  }
  processDepositEvent(req.body);
});
```

### dex.unvalidated-withdrawal-amount
- **Title:** Negative/zero/oversized withdrawal amount not validated
- **CWE:** CWE-20
- **Severity:** critical
- **VulnClass:** money-integrity
- **Invariant:** A withdrawal amount is validated as a positive integer no greater than the account's available balance before any debit or signing occurs.
- **Keywords:** amount, negative, validation, balance check, withdrawal

**Unsafe:**
```ts
await executeWithdrawal(userId, req.body.amount, req.body.address); // amount never bounds-checked
```

**Safe:**
```ts
if (!Number.isInteger(req.body.amount) || req.body.amount <= 0 || req.body.amount > await getBalance(userId)) {
  throw new Error("invalid withdrawal amount");
}
await executeWithdrawal(userId, req.body.amount, req.body.address);
```
