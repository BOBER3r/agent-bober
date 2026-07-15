# ADR-2: WHOOP OAuth credentials via process.env; refresh token in a 0600 sidecar, separate from the transport

**Decision:** A dedicated `WhoopTokenStore` loads `WHOOP_CLIENT_ID`/`WHOOP_CLIENT_SECRET` from `process.env` and persists the offline-scope refresh token at `.bober/medical/whoop-token.json` with mode 0600, kept as a separate component from `WhoopClient` (which stays pure transport).

**Context:** WHOOP's only supported flow is OAuth2 Authorization Code; long-lived background sync needs the offline-scope refresh token persisted at rest. The codebase has no secret store, and the single ESLint-excepted network file must stay minimal and auditable.

**Options Considered:**

| Option | Pros | Cons |
|--------|------|------|
| A: env vars + 0600 sidecar in a separate `WhoopTokenStore` | Mirrors provider env precedent (`src/providers/factory.ts:96-136`) + `AuditLog`/`ConsentGate` 0600 pattern (`src/medical/audit.ts:50`, `src/medical/consent.ts:30`); keeps `WhoopClient` pure transport | Token-at-rest is plaintext on disk (single-user local machine) |
| B: token persistence inside `WhoopClient` | One fewer component | Mixes credential I/O into the one ESLint-excepted network file, enlarging the audited-egress surface and coupling refresh logic to transport |
| C: OS keychain integration | Encrypted at rest | New cross-platform dependency; contradicts approved assumption #1 (env-var precedent) and the local-first JSON-sidecar norm |

**Rationale:** The Locked Dependency "secrets come from `process.env` (`src/providers/factory.ts`), NOT a new in-tree secret store" plus approved assumption #1 eliminate C; the zero-egress audit posture (keep the network file minimal) eliminates B in favour of a separate token store reusing the existing 0600 sidecar pattern.

**Consequences:** WHOOP auth requires `WHOOP_CLIENT_ID`/`WHOOP_CLIENT_SECRET` in the environment; an unauthorized state (no refresh token) makes `whoop sync` print a clear authorize-first message rather than throwing; `whoop-token.json` joins `consent.json`/`audit-*.jsonl` under `.bober/medical/` at 0600.

**Risk:** If the host filesystem is shared or backed up unencrypted, the plaintext refresh token is exposed — acceptable for a single self-responsible user on a personal machine, documented; if multi-user hosting is ever needed, Option C becomes mandatory.
