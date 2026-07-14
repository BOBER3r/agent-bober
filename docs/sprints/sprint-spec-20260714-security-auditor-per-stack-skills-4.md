# Web/backend per-stack security skill files: node, payments, react

**Contract:** sprint-spec-20260714-security-auditor-per-stack-skills-4  ·  **Spec:** spec-20260714-security-auditor-per-stack-skills  ·  **Completed:** 2026-07-14

## What this sprint added

The last three per-stack **security signature libraries** — the general web/backend stacks — authored in the sprint-2 block format and sourced from `research-20260714` section A (OWASP/injection) plus the payments/webhook items in section B. Each is a `skills/bober.security-<stack>/SKILL.md` data file (not a workflow skill) of discrete labelled vulnerable/safe signature blocks that `SecuritySignatureParser.parse()` turns into typed `SecuritySignature[]` records:

- **`bober.security-node`** — 12 Node/Express backend signatures (SQL injection, ORM raw escape hatches, OS command injection, path traversal, SSRF, BOLA/missing-ownership, BOPLA/mass-assignment, BFLA/no-role-gate, insecure deserialization, `vm`-as-sandbox misuse, hardcoded/logged secrets, JWT `alg:none`/session fixation).
- **`bober.security-payments`** — 10 payments/PSP backend signatures (webhook HMAC, non-constant-time compare + replay window, atomic idempotency key, duplicate-credit on webhook replay, refund/chargeback abuse, float money / currency mismatch, withdraw-to-different-method, withdrawal approval threshold / dual control, client-supplied amount, unvalidated refund amount).
- **`bober.security-react`** — 8 React client-side signatures (`dangerouslySetInnerHTML`, `innerHTML`/`document.write`, secret in client bundle, client-side-trusted authz, unsafe `href`/open redirect, `postMessage` without origin check, prototype pollution via client deep-merge, auth token in `localStorage`).

**This completes all 8 per-stack security signature libraries** — the four money/crypto stacks (sprint 3: solidity, anchor, igaming, dex-backend), the shared `generic` OWASP/CWE library (sprint 2), and these three web/backend stacks. A new enumeration test locks the exact set. As with every prior library, nothing is wired into `runSecurityAudit` yet — these files remain dormant data plumbing that the sprint-5 index/selector will consume.

## Public surface

These are **data files**, not code — their "public surface" is the set of stable `signatureId`s each file exposes to the parser (retrieval keys the sprint-5 selector will match against).

- `skills/bober.security-node/SKILL.md` — **12** blocks: `node.sql-injection` (`:38`), `node.orm-raw-escape-hatch` (`:56`), `node.command-injection` (`:74`), `node.path-traversal` (`:92`), `node.ssrf-outbound-fetch` (`:113`), `node.bola-missing-ownership` (`:132`), `node.mass-assignment-bopla` (`:153`), `node.bfla-admin-no-role-gate` (`:172`), `node.insecure-deserialization` (`:192`), `node.vm-not-a-sandbox` (`:210`), `node.secrets-hardcoded-logged` (`:230`), `node.jwt-alg-none` (`:250`).
- `skills/bober.security-payments/SKILL.md` — **10** blocks: `payments.webhook-missing-hmac` (`:38`), `payments.webhook-nonconstant-compare` (`:60`), `payments.missing-idempotency-key` (`:81`), `payments.duplicate-credit-webhook-replay` (`:103`), `payments.refund-chargeback-abuse` (`:128`), `payments.float-money-currency-mismatch` (`:150`), `payments.withdraw-different-method` (`:169`), `payments.missing-withdrawal-approval-threshold` (`:189`), `payments.client-supplied-amount` (`:211`), `payments.unvalidated-refund-amount` (`:230`).
- `skills/bober.security-react/SKILL.md` — **8** blocks: `react.dangerously-set-inner-html` (`:39`), `react.raw-innerhtml-documentwrite` (`:57`), `react.secret-in-client-bundle` (`:75`), `react.client-trusted-authz` (`:94`), `react.unsafe-href-redirect` (`:112`), `react.postmessage-no-origin` (`:131`), `react.prototype-pollution-deepmerge` (`:152`), `react.token-in-localstorage` (`:177`).
- `src/orchestrator/security-knowledge/skill-files.test.ts` — extended: the real-asset table now parses **seven** files (sprint-3's four money/crypto stacks plus these three) and asserts each parses to its exact authored block count with **zero dropped blocks**, all `vulnClass ∈ ALL_VULN_CLASSES`, and no block uses the non-union `'access-control'` class. A **new** case enumerates `skills/bober.security-*/SKILL.md`, asserts the set equals exactly the **8 expected stacks** (`solidity`, `anchor`, `react`, `node`, `payments`, `igaming`, `dex-backend`, `generic`) — explicitly **excluding** `bober.security-audit`, the audit *workflow* skill — and that each parses to ≥ 6 signatures.

## How it fits

The three files cover the general web/backend surface the money stacks assume around them:

- **`security-node`** leans on the BOLA/BOPLA/BFLA object-and-function-level authorization family (BOLA is ~40% of API attacks per the research) and the raw-SQL escape hatches (`.raw`/`.literal`/`$queryRawUnsafe`/`$where`) that bypass an ORM's parameterization. It overlaps the `generic` OWASP library by design but is stack-scoped (Express/Node idioms) and independently parseable.
- **`security-payments`** emphasizes the two highest-value money-integrity controls: webhook HMAC verification (over the **raw** request body, with `crypto.timingSafeEqual` and a signed-timestamp replay window) and **atomic** idempotency (a DB unique-constraint insert, never an application-level check-then-insert). It is the off-chain money-movement complement to `security-igaming`/`security-dex-backend`.
- **`security-react`** is the client-side surface — XSS sinks (`dangerouslySetInnerHTML`/`innerHTML`/`document.write`), the "secret shipped in the bundle" and "security decision trusted client-side" trust-boundary classes, and client-parsed-input hazards (open redirect, `postMessage` origin, prototype pollution). It is explicitly distinct from `skills/bober.react/SKILL.md`, the unrelated React *framework* dev skill (a non-goal to touch).

Every block's `vulnClass` is drawn from the sprint-1 widened 17-class taxonomy: node uses `injection`, `path-traversal`, `ssrf`, `idor-bola`, `authn-authz`, `deserialization`, `secret-handling`; payments uses `authn-authz`, `crypto-weakness`, `race-condition`, `money-integrity`; react uses `xss`, `secret-handling`, `authn-authz`, `input-validation`. No block uses `access-control` (never a union member).

## Notes for maintainers

- **Still dormant.** This sprint changed no TypeScript runtime behavior: the three files are not referenced by `runSecurityAudit`, the gate, or the CLI. They become live only when the sprint-5 index/selector loads them and feeds the finder. The suite stayed green at **4099** (315 files).
- **Adding/editing a signature = editing markdown, not code.** These files share the sprint-2 block format one-for-one; the `## Signature Block Format` section is repeated in each file and must stay in sync with `parser.ts`. A `VulnClass` line naming a class outside `ALL_VULN_CLASSES` is silently **dropped**, not coerced — the zero-drop assertion in `skill-files.test.ts` is the guard that catches it.
- **The enumeration test is now a lock.** Adding a ninth `skills/bober.security-<stack>/SKILL.md` (or renaming one of the eight) will fail the exact-set assertion until the `EXPECTED` list is updated — deliberate, so the stack roster can't drift silently. The test excludes `bober.security-audit` by name because that is the workflow skill, not a signature stack.
- **Non-goals honored.** No index/selector/registry or finder wiring (sprint 5), no change to `skills/bober.react/SKILL.md` (the framework skill), and no runtime behavior change.

## Follow-ups (non-blocking, do NOT fix here)

- **`node.orm-raw-escape-hatch` has no distinct NoSQL example (evaluator nit, iteration 1 `generatorFeedback`, low priority).** The block covers the **SQL** raw escape-hatch class (`$queryRawUnsafe`/`.raw`/`.literal`) but does not carry a separate NoSQL/Mongo example (e.g. a `$where` operator injection or `$`-operator query-selector injection). Its `Keywords` line lists `$where`, but there is no dedicated NoSQL unsafe/safe pair. This did **not** block the sprint. Candidate touch-up for a future sprint: add a distinct `node.nosql-injection` (or `node.mongo-where-injection`) signature block, or narrow the block's stated scope to SQL. Not fixed here (docs-only sprint).

## Scope

One commit — `09918db` (`bober(sprint-4): author node/payments/react security skill files + 8-stack enumeration test`) — adding three `skills/bober.security-{node,payments,react}/SKILL.md` libraries and extending `src/orchestrator/security-knowledge/skill-files.test.ts` (773 insertions, 7 deletions across 4 files). All 5 required criteria (sc-4-1..4-5) passed on iteration 1; typecheck, build, lint, and the full suite (315 files / **4099 tests**) green. Zero-drop parse confirmed at 12/10/8 blocks with all-union `vulnClass`es; the enumeration test locks exactly the 8 expected stacks.
