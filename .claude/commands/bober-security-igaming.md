---
name: bober.security-igaming
description: "iGaming/betting backend security signature library. Not a workflow skill -- a data file of discrete vulnerable/safe code signature blocks read by SecuritySignatureParser. Covers TOCTOU balance double-spend, non-atomic settlement/idempotency, client-supplied odds trust, negative/zero stake, float money, missing webhook HMAC, seamless-wallet rollback abuse, non-CSPRNG outcomes, client-side outcome determination, client-side-only limits, bonus/wagering abuse, and settlement replay."
---

# bober.security-igaming — iGaming/Betting Backend Security Signature Library

This skill is a **signature-library** file, not a workflow skill. It is read (as raw
markdown text) by `SecuritySignatureParser.parse()`
(`src/orchestrator/security-knowledge/parser.ts`) and turned into typed
`SecuritySignature[]` records used by the security-audit agent team. Do not confuse this
with `bober.security-audit`, which is the audit *workflow* skill.

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

### igaming.toctou-balance-double-spend
- **Title:** TOCTOU balance double-spend (read-check-write, no lock)
- **CWE:** CWE-362
- **Severity:** critical
- **VulnClass:** race-condition
- **Invariant:** A balance debit is a single atomic conditional write — the check and the write execute as one statement, never a separate read followed by a later write.
- **Keywords:** balance, FOR UPDATE, TOCTOU, double-spend, atomic

**Unsafe:**
```ts
const account = await db.query("SELECT balance FROM accounts WHERE id = $1", [id]);
if (account.balance >= amount) {
  await db.query("UPDATE accounts SET balance = balance - $1 WHERE id = $2", [amount, id]);
}
```

**Safe:**
```ts
const result = await db.query(
  "UPDATE accounts SET balance = balance - $1 WHERE id = $2 AND balance >= $1 RETURNING balance",
  [amount, id],
);
if (result.rowCount === 0) throw new Error("insufficient balance");
```

### igaming.non-atomic-idempotency
- **Title:** Missing/non-atomic idempotency key on deposit/settlement
- **CWE:** CWE-362
- **Severity:** critical
- **VulnClass:** race-condition
- **Invariant:** A deposit or settlement request is applied at most once per idempotency key, enforced by a unique constraint at the database layer, not by an application-level check-then-insert.
- **Keywords:** idempotency, idempotency-key, settlement, unique, upsert

**Unsafe:**
```ts
const existing = await db.query("SELECT id FROM settlements WHERE key = $1", [idempotencyKey]);
if (!existing) await db.query("INSERT INTO settlements (key, amount) VALUES ($1, $2)", [idempotencyKey, amount]);
```

**Safe:**
```ts
await db.query(
  "INSERT INTO settlements (key, amount) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", // key has a UNIQUE constraint
  [idempotencyKey, amount],
);
```

### igaming.client-supplied-odds
- **Title:** Trusting client-supplied odds/price at bet acceptance
- **CWE:** CWE-602
- **Severity:** critical
- **VulnClass:** money-integrity
- **Invariant:** The payout for an accepted bet is computed from the server's current price for the selection id at acceptance time, never from an odds value the client submitted in the request body.
- **Keywords:** odds, price, selectionId, payout, re-resolve

**Unsafe:**
```ts
const payout = req.body.stake * req.body.odds; // client controls the multiplier directly
```

**Safe:**
```ts
const currentOdds = await priceService.getOdds(req.body.selectionId); // server-resolved at acceptance
const payout = req.body.stake * currentOdds;
```

### igaming.negative-zero-stake
- **Title:** Negative/zero stake inverts debit to credit
- **CWE:** CWE-20
- **Severity:** critical
- **VulnClass:** money-integrity
- **Invariant:** A stake amount is validated as a positive integer above the platform's minimum before any debit occurs — a negative or zero value is rejected, never processed.
- **Keywords:** stake, negative, amount, validation, <= 0

**Unsafe:**
```ts
await debit(userId, req.body.stake); // stake = -1000 credits the account instead of debiting it
```

**Safe:**
```ts
if (!Number.isInteger(req.body.stake) || req.body.stake <= 0) throw new Error("invalid stake");
await debit(userId, req.body.stake);
```

### igaming.float-money
- **Title:** Float money instead of integer minor units / Decimal
- **CWE:** CWE-681
- **Severity:** high
- **VulnClass:** money-integrity
- **Invariant:** Monetary amounts are represented as integer minor units (cents) or an arbitrary-precision Decimal type end-to-end — never IEEE-754 floats, which drift under repeated arithmetic.
- **Keywords:** float, Number, minor units, Decimal, rounding, cents

**Unsafe:**
```ts
balance += 0.1; // repeated float addition drifts from the true balance over many operations
```

**Safe:**
```ts
balanceCents += 10; // integer minor units, no drift
```

### igaming.missing-webhook-hmac
- **Title:** Missing/incorrect provider webhook HMAC + timestamp verification
- **CWE:** CWE-345
- **Severity:** critical
- **VulnClass:** authn-authz
- **Invariant:** A webhook payload is only processed after its HMAC signature over the raw request body is verified with a constant-time comparison and its timestamp is checked against replay drift.
- **Keywords:** webhook, HMAC, timingSafeEqual, raw-body, timestamp

**Unsafe:**
```ts
app.post("/webhook", (req, res) => { applySettlement(req.body); }); // body trusted, unsigned
```

**Safe:**
```ts
const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-signature"])) ||
    Date.now() - Number(req.headers["x-timestamp"]) > MAX_SKEW_MS) {
  return res.status(401).end();
}
applySettlement(req.body);
```

### igaming.seamless-wallet-orphan-rollback
- **Title:** Orphan / replayed seamless-wallet rollback credit
- **Severity:** critical
- **VulnClass:** money-integrity
- **Invariant:** A rollback credit is only applied when it matches an existing debit transaction by a composite provider/round/transaction key, and each rollback key is processed at most once.
- **Keywords:** seamless wallet, rollback, orphan, roundId, txId, dedup

**Unsafe:**
```ts
await credit(userId, req.body.amount); // rollback credited with no matching prior debit, replayable
```

**Safe:**
```ts
const debit = await findDebit(providerId, req.body.roundId, req.body.txId);
if (!debit) throw new Error("no matching debit for rollback");
await db.query(
  "INSERT INTO rollbacks (provider_id, round_id, tx_id, tx_type) VALUES ($1, $2, $3, 'rollback') ON CONFLICT DO NOTHING RETURNING id",
  [providerId, req.body.roundId, req.body.txId],
);
await credit(userId, debit.amount);
```

### igaming.non-csprng-outcome
- **Title:** Math.random() for game outcome (fails GLI-19 certification)
- **CWE:** CWE-338
- **Severity:** critical
- **VulnClass:** insecure-randomness
- **Invariant:** A game outcome that determines a payout is generated from a certified CSPRNG seeded with at least 256 bits of entropy, never `Math.random()`.
- **Keywords:** Math.random, RNG, CSPRNG, outcome, seed, GLI-19

**Unsafe:**
```ts
const outcome = Math.floor(Math.random() * reelSymbols.length); // predictable, not certifiable
```

**Safe:**
```ts
const outcome = certifiedRng.nextInt(reelSymbols.length); // certified CSPRNG, seeded >= 256 bits
```

### igaming.client-side-outcome
- **Title:** Client-determined outcome trusted by server
- **CWE:** CWE-602
- **Severity:** critical
- **VulnClass:** authn-authz
- **Invariant:** The server independently computes the authoritative round outcome; a client-submitted result value is never accepted as-is for settlement.
- **Keywords:** client-side, outcome, server-authoritative, trust boundary

**Unsafe:**
```ts
await settleRound(req.body.result); // client tells the server what it won
```

**Safe:**
```ts
const result = await computeAuthoritativeOutcome(roundId); // server-computed, ignores client claims
await settleRound(result);
```

### igaming.limits-client-only
- **Title:** Deposit-limit / self-exclusion enforced client-side only
- **CWE:** CWE-602
- **Severity:** high
- **VulnClass:** authn-authz
- **Invariant:** Deposit limits and self-exclusion status are enforced by a server-side check on every deposit/bet request, not merely by disabling controls in the UI.
- **Keywords:** deposit limit, self-exclusion, KYC, client-side, GAMSTOP

**Unsafe:**
```ts
// UI disables the deposit button once the limit is reached; the API accepts any amount
app.post("/deposit", (req, res) => { processDeposit(req.body.amount); });
```

**Safe:**
```ts
app.post("/deposit", async (req, res) => {
  await assertWithinDepositLimit(req.session.userId, req.body.amount); // server-enforced, throws if exceeded
  await assertNotSelfExcluded(req.session.userId);
  processDeposit(req.body.amount);
});
```

### igaming.bonus-wagering-abuse
- **Title:** Bonus / wagering-requirement bypass (multi-account, self-referral)
- **CWE:** CWE-841
- **Severity:** high
- **VulnClass:** money-integrity
- **Invariant:** Bonus funds are withdrawable only after the wagering requirement is met on qualifying real-money play, and bonus eligibility is checked against multi-account/self-referral signals, not per-account state alone.
- **Keywords:** bonus, wagering requirement, multi-account, self-referral

**Unsafe:**
```ts
await withdraw(userId, bonusBalance); // no check that wagering requirement was met
```

**Safe:**
```ts
const progress = await getWageringProgress(userId);
if (progress.wagered < progress.required) throw new Error("wagering requirement not met");
if (await isSelfReferralOrMultiAccount(userId)) throw new Error("bonus ineligible");
await withdraw(userId, bonusBalance);
```

### igaming.settlement-replay
- **Title:** Replayed settlement/payout webhook without provider-event dedup
- **Severity:** critical
- **VulnClass:** money-integrity
- **Invariant:** Each provider settlement event is applied at most once, keyed by the provider's unique event id enforced with a database uniqueness constraint.
- **Keywords:** settlement, replay, dedup, provider-event, unique

**Unsafe:**
```ts
app.post("/settlement", async (req, res) => { await applyPayout(req.body); }); // same event processed twice on retry
```

**Safe:**
```ts
app.post("/settlement", async (req, res) => {
  const inserted = await db.query(
    "INSERT INTO settlement_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id",
    [req.body.eventId],
  );
  if (inserted.rowCount === 0) return res.status(200).end(); // already processed
  await applyPayout(req.body);
});
```
