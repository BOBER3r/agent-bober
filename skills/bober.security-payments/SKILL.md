---
name: bober.security-payments
description: "Payments/PSP backend security signature library. Not a workflow skill -- a data file of discrete vulnerable/safe code signature blocks read by SecuritySignatureParser. Covers webhook HMAC verification, non-constant-time signature comparison, idempotency keys, duplicate-credit on webhook replay, refund/chargeback abuse, float money, withdrawal-to-different-method, withdrawal approval thresholds, client-supplied amounts, and unvalidated refund amounts."
---

# bober.security-payments — Payments/PSP Backend Security Signature Library

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

### payments.webhook-missing-hmac
- **Title:** PSP webhook processed without HMAC signature verification
- **CWE:** CWE-345
- **Severity:** critical
- **VulnClass:** authn-authz
- **Invariant:** A PSP webhook payload is only processed after its HMAC signature over the raw request body is verified — an unsigned or unverified webhook body is never trusted.
- **Keywords:** webhook, HMAC, PSP, raw-body, signature, verify

**Unsafe:**
```ts
app.post("/psp/webhook", (req, res) => { applyPayment(req.body); }); // no signature check
```

**Safe:**
```ts
app.post("/psp/webhook", (req, res) => {
  const expected = crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex");
  if (!verifySignature(expected, req.headers["x-psp-signature"])) return res.status(401).end();
  applyPayment(req.body);
});
```

### payments.webhook-nonconstant-compare
- **Title:** Webhook signature compared non-constant-time / no replay timestamp
- **CWE:** CWE-208
- **Severity:** high
- **VulnClass:** crypto-weakness
- **Invariant:** A webhook signature comparison always uses a constant-time comparison and rejects payloads whose signed timestamp falls outside an acceptable replay window.
- **Keywords:** timingSafeEqual, timing attack, ===, timestamp, replay

**Unsafe:**
```ts
if (req.headers["x-psp-signature"] === expected) applyPayment(req.body);
```

**Safe:**
```ts
const inWindow = Date.now() - Number(req.headers["x-psp-timestamp"]) <= MAX_SKEW_MS;
if (inWindow && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers["x-psp-signature"]))) {
  applyPayment(req.body);
}
```

### payments.missing-idempotency-key
- **Title:** Missing/non-atomic idempotency key on a money endpoint
- **CWE:** CWE-362
- **Severity:** critical
- **VulnClass:** race-condition
- **Invariant:** A charge request is applied at most once per idempotency key, enforced by a unique constraint at the database layer via an atomic insert — never by an application-level check-then-insert.
- **Keywords:** idempotency, idempotency-key, atomic, unique, upsert

**Unsafe:**
```ts
const existing = await db.query("SELECT id FROM charges WHERE key = $1", [idempotencyKey]);
if (!existing) await db.query("INSERT INTO charges (key, amount) VALUES ($1, $2)", [idempotencyKey, amount]);
```

**Safe:**
```ts
await db.query(
  "INSERT INTO charges (key, amount) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", // key is UNIQUE
  [idempotencyKey, amount],
);
```

### payments.duplicate-credit-webhook-replay
- **Title:** Duplicate credit on PSP webhook replay (no event dedup)
- **CWE:** CWE-799
- **Severity:** critical
- **VulnClass:** money-integrity
- **Invariant:** Each provider webhook event is applied at most once, keyed by the provider's unique event id enforced with a database uniqueness constraint — a retried event never credits the account twice.
- **Keywords:** webhook, replay, dedup, provider-event, double-credit

**Unsafe:**
```ts
app.post("/webhook", async (req, res) => { await creditAccount(req.body); }); // "payment_intent.succeeded" retried by PSP credits twice
```

**Safe:**
```ts
app.post("/webhook", async (req, res) => {
  const inserted = await db.query(
    "INSERT INTO webhook_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id",
    [req.body.id],
  );
  if (inserted.rowCount === 0) return res.status(200).end(); // already processed
  await creditAccount(req.body);
});
```

### payments.refund-chargeback-abuse
- **Title:** Refund/chargeback abuse (over-refund, double refund, post-chargeback)
- **CWE:** CWE-840
- **Severity:** critical
- **VulnClass:** money-integrity
- **Invariant:** A refund amount never exceeds the captured amount minus amounts already refunded, and no further refund is issued once a charge has been disputed/charged back.
- **Keywords:** refund, chargeback, over-refund, double refund, dispute

**Unsafe:**
```ts
await refund(chargeId, req.body.amount); // no cap against captured-minus-already-refunded
```

**Safe:**
```ts
const charge = await getCharge(chargeId);
if (charge.disputed) throw new Error("charge is disputed");
const remaining = charge.capturedAmount - charge.refundedAmount;
if (req.body.amount > remaining) throw new Error("refund exceeds remaining captured amount");
await refund(chargeId, req.body.amount);
```

### payments.float-money-currency-mismatch
- **Title:** Float money / currency-conversion mismatch
- **CWE:** CWE-681
- **Severity:** high
- **VulnClass:** money-integrity
- **Invariant:** Monetary amounts are represented as integer minor units with an explicit currency code end-to-end — amounts in different currencies are never added directly, and amounts are never stored or summed as IEEE-754 floats.
- **Keywords:** float, minor units, currency, Decimal, rounding, cents

**Unsafe:**
```ts
totalUsd += lineItem.price * 1.1; // float drift; also silently adds a EUR line item's price
```

**Safe:**
```ts
if (lineItem.currency !== "USD") throw new Error("currency mismatch");
totalCents += Math.round(lineItem.priceCents * 1.1); // integer minor units
```

### payments.withdraw-different-method
- **Title:** Withdrawal to a method different from the funding source
- **CWE:** CWE-840
- **Severity:** critical
- **VulnClass:** money-integrity
- **Invariant:** A withdrawal payout is only permitted to the same verified instrument the funds were originally deposited from — an arbitrary attacker-supplied destination account is never accepted.
- **Keywords:** withdrawal, payout, funding source, cash-out, method

**Unsafe:**
```ts
await payout(userId, req.body.destinationAccount, req.body.amount); // any destination accepted
```

**Safe:**
```ts
const fundingInstrument = await getVerifiedFundingInstrument(userId);
if (req.body.destinationAccount !== fundingInstrument.id) throw new Error("destination must match funding source");
await payout(userId, fundingInstrument.id, req.body.amount);
```

### payments.missing-withdrawal-approval-threshold
- **Title:** Large withdrawal with no approval threshold / dual control
- **CWE:** CWE-862
- **Severity:** high
- **VulnClass:** authn-authz
- **Invariant:** A withdrawal above a configured threshold requires a second approver (dual control) before funds move — no withdrawal amount is auto-approved unconditionally.
- **Keywords:** withdrawal, approval, threshold, dual control, four-eyes

**Unsafe:**
```ts
await processWithdrawal(userId, req.body.amount); // any size auto-approved
```

**Safe:**
```ts
if (req.body.amount > WITHDRAWAL_APPROVAL_THRESHOLD_CENTS) {
  await queueForDualControlApproval(userId, req.body.amount);
} else {
  await processWithdrawal(userId, req.body.amount);
}
```

### payments.client-supplied-amount
- **Title:** Trusting client-supplied price/amount at charge time
- **CWE:** CWE-602
- **Severity:** critical
- **VulnClass:** money-integrity
- **Invariant:** The amount charged is always computed from the server-side order/catalog at charge time — a price or amount value submitted by the client is never used directly.
- **Keywords:** amount, price, tampering, client-supplied, server-side

**Unsafe:**
```ts
await charge(userId, req.body.amount); // client controls the charged amount directly
```

**Safe:**
```ts
const order = await getOrder(req.body.orderId); // server-resolved amount from the catalog/order record
await charge(userId, order.totalCents);
```

### payments.unvalidated-refund-amount
- **Title:** Negative/oversized refund amount not validated
- **CWE:** CWE-20
- **Severity:** high
- **VulnClass:** money-integrity
- **Invariant:** A refund amount is validated as a positive integer no greater than the captured amount before any refund is issued — a negative, zero, or oversized value is rejected.
- **Keywords:** refund, negative, validation, amount, bound

**Unsafe:**
```ts
await refund(chargeId, req.body.amount); // negative amount inverts refund into a charge
```

**Safe:**
```ts
if (!Number.isInteger(req.body.amount) || req.body.amount <= 0 || req.body.amount > charge.capturedAmount) {
  throw new Error("invalid refund amount");
}
await refund(chargeId, req.body.amount);
```
