# WHOOP egress axis + authenticated transport

**Contract:** sprint-spec-20260617-medical-whoop-guardrails-2  ·  **Spec:** spec-20260617-medical-whoop-guardrails  ·  **Completed:** 2026-06-17

## What this sprint added

Establishes **authenticated, egress-gated access to WHOOP** without yet persisting any
data. Two things land together: (1) a **third independent egress axis**,
`device-connection`, on the existing `EgressGuard` — so the medical team now gates
**three** orthogonal outbound channels (`cloud-inference`, `literature-retrieval`,
`device-connection`), all still default **false**; and (2) the WHOOP transport layer —
a network-free `WhoopTokenStore` (env credentials + a `0600` refresh-token sidecar) and
a `WhoopClient` that performs the OAuth2 refresh-token grant and paginated WHOOP **v2**
GETs. `WhoopClient` is the **second** ESLint-excepted network file (sibling to
`retrieval/medline-source.ts`), it calls `assertAllowed("device-connection")` **before**
any HTTP, and its transport is an injectable `FetchLike` so CI runs fully offline. This
is **Sprint 2 of the whoop-guardrails spec** — no sync adapter, record mapping,
persistence, or CLI yet (Sprint 3).

## Public surface

### `src/medical/egress.ts` (extended — third axis)

- `type EgressAxis` (`egress.ts:5`) — now a **3-value** union:
  `"cloud-inference" | "literature-retrieval" | "device-connection"`. The new value is
  purely additive.
- `class EgressGuard` constructor (`egress.ts:18`) — gained an **optional** third
  parameter `deviceConnection: boolean = false`. Because it is optional, every existing
  2-arg call site stays **byte-identical** — no caller had to change.
- `EgressGuard.isAllowed(axis)` (`egress.ts:35`) — the ternary became an **exhaustive
  `switch`** with a compile-time `const _exhaustive: never = axis` default guard
  (`egress.ts:44`); a future unhandled `EgressAxis` value is now a type error.
- `EgressGuard.fromConfig(config)` (`egress.ts:25`) — now also reads
  `config.medical?.egress?.deviceConnection ?? false`. Axes remain **independent** — the
  three constructor fields are read with no cross-field logic, so enabling one never
  enables another.

### `src/config/schema.ts` (extended)

- `MedicalSectionSchema.egress.deviceConnection` (`schema.ts:385`) —
  `z.boolean().default(false)`, a sibling to the existing `cloudInference` /
  `literatureRetrieval` flags. Absent ⇒ `false`.

### `src/medical/whoop/whoop-token.ts` (new — **NO network imports**, ADR-2)

- `interface WhoopTokens` (`whoop-token.ts:9`) — `{ accessToken; refreshToken;
  expiresAtIso }`, the bundle persisted at `.bober/medical/whoop-token.json`.
- `class WhoopTokenStore` (`whoop-token.ts:31`) — `constructor(projectRoot: string)`.
  - `clientCredentials()` (`:46`) — reads `WHOOP_CLIENT_ID` / `WHOOP_CLIENT_SECRET`
    from `process.env` (mirroring `src/providers/factory.ts`); **throws** a clear
    "set `WHOOP_CLIENT_ID` and `WHOOP_CLIENT_SECRET`" message when either is unset.
    **There is no OS keychain** — credentials come from env vars only (ADR-2).
  - `readRefreshToken()` (`:64`) — returns the stored refresh token, or `undefined`
    when the sidecar is absent **or corrupt** (fail-closed: any read/parse error ⇒
    `undefined`, treated as "not yet authorised").
  - `writeTokens(tokens)` (`:79`) — writes the JSON sidecar with file mode **`0600`**
    (passed directly to `writeFile`, not chmod-after), creating `.bober/medical/` if
    absent (mirrors `consent.ts`/`audit.ts`).

### `src/medical/whoop/whoop-client.ts` (new — **the SECOND ESLint-excepted network file**, ADR-1)

- `type WhoopCollection` (`whoop-client.ts:17`) — `"recovery" | "sleep" | "cycle" |
  "workout"`, mapped to v2 paths `/v2/recovery`, `/v2/activity/sleep`, `/v2/cycle`,
  `/v2/activity/workout` (`COLLECTION_PATHS`, `:60`).
- `type SyncWindow` (`:20`) — `{ startIso; endIso }` ISO-8601 fetch window.
- `type WhoopRecord` (`:23`) / `type WhoopPage` (`:31`) — a normalised record
  (`id` / `tStartIso` / `tEndIso?` / numeric `metrics`) and one page
  (`{ records; nextCursor? }`; `nextCursor` absent ⇒ last page).
- `type FetchLike` (`:40`) — the injectable transport (extends the MedlineSource shape
  to carry `init` for the POST grant + authorised GET, and `headers.get(name)` for the
  429 reset header). Defaults to global `fetch` **only here**; tests inject a fixture
  fake so CI never hits the network.
- `class WhoopClient` (`:148`) —
  `constructor(egress, tokenStore, fetchImpl?, waiter?, nowIso?)`. The `waiter` and
  `nowIso` are injected so tests never sleep and never read `Date.now()`.
  - `ensureAccessToken(): Promise<string>` (`:181`) — `assertAllowed("device-connection")`
    is the **first** executable line; returns the in-memory cached token if unexpired,
    else performs the OAuth2 `refresh_token` grant (scope `offline`) against
    `WHOOP_TOKEN_URL`, persists the rotated tokens, caches and returns the new access
    token. A `401`/`invalid_grant` from the token endpoint throws a clear "re-authorize"
    error.
  - `fetchPage(collection, window, cursor?): Promise<WhoopPage>` (`:266`) —
    `assertAllowed("device-connection")` first; gets/refreshes the Bearer token; GETs the
    v2 endpoint with `start` / `end` / `nextToken` query params; on **`401`** forces a
    refresh and retries **exactly once** (a second `401` throws — no loop); on **`429`**
    reads `X-RateLimit-Reset` (seconds, default 60), `await`s the injected `waiter`
    (`reset * 1000` ms), then retries; parses the response into a `WhoopPage`.

### `eslint.config.js` (extended)

- The medical network-exception `files` list (`eslint.config.js:100`) now contains
  **both** `src/medical/retrieval/medline-source.ts` **and**
  `src/medical/whoop/whoop-client.ts` — and nothing else under `src/medical`.

## How to use / how it fits

The `device-connection` axis is opted in via config, mirroring the other two egress
flags:

```jsonc
{
  "medical": {
    "egress": {
      "cloudInference": false,        // (independent) cloud inference synthesis
      "literatureRetrieval": false,   // (independent) MedlinePlus retrieval
      "deviceConnection": true        // permit WHOOP device-connection egress (default false)
    }
  }
}
```

`WhoopClient` is wired from an `EgressGuard` (typically `EgressGuard.fromConfig(config)`)
and a `WhoopTokenStore(projectRoot)`. WHOOP credentials are supplied as environment
variables — `WHOOP_CLIENT_ID` and `WHOOP_CLIENT_SECRET` — and the rotating refresh token
is kept in a `0600` sidecar at `.bober/medical/whoop-token.json` (no OS keychain). With
`deviceConnection` off (the default), every `WhoopClient` method **throws** before any
HTTP and the injected transport is never called, so the WHOOP path adds **zero outbound
bytes** by default — exactly like the other two axes. There is no `bober medical whoop`
CLI yet; the sync adapter, record→`HealthObservation` mapping, and the CLI land in
Sprint 3.

## Notes for maintainers

- **Three independent axes, all default false.** `device-connection` joins
  `cloud-inference` and `literature-retrieval` as a peer. Independence is **by
  construction** — `isAllowed` reads each backing field directly with no cross-field
  logic — and a unit test asserts the full independence matrix. Do not introduce
  coupling between axes.
- **The `never`-guard is load-bearing.** `isAllowed`'s `switch` default holds
  `const _exhaustive: never = axis`. If you add a fourth `EgressAxis` value, the build
  will fail here until you handle it — keep the guard.
- **Constructor compatibility is intentional.** The third `EgressGuard` constructor
  param is **optional** (`= false`) specifically so existing 2-arg call sites stay
  byte-identical. Do not make it required without auditing every caller.
- **All WHOOP HTTP lives in `whoop-client.ts` — and only there.** It is the second (and
  last) entry on the `eslint.config.js` medical network-exception list. `whoop-token.ts`
  is deliberately **network-free** (it imports only `node:fs/promises` / `node:path` /
  `utils/fs`). A `grep` over `src/medical` (excluding `whoop-client.ts` + tests) finds
  zero network usage — keep it that way; new outbound calls go inside `whoop-client.ts`
  or fail `npm run lint`.
- **`assertAllowed` runs before any fetch.** It is the first statement of both
  `ensureAccessToken` and `fetchPage` — runtime defence-in-depth backing the static
  ESLint boundary (mirrors `medline-source.ts`). A test asserts both throw with the axis
  off and the `FetchLike` spy records **zero** calls.
- **Injectable clock + waiter, never real sleep.** `waiter` (429 backoff) and `nowIso`
  (token-expiry comparison) are constructor-injected; production defaults are
  `setTimeout` and `new Date().toISOString()` respectively — **no** `Date.now()` inside
  the impl. Tests pass a recording no-wait waiter and a fixed `nowIso`, so the 429-Reset
  and refresh paths are assertable without sleeping or hitting the network.
- **401 retries exactly once.** A `401` forces one refresh+retry; a second `401` throws.
  Do not turn this into an unbounded retry loop.
- **No `URLSearchParams`.** It is not declared in the ESLint globals config, so query
  strings and the form body are built manually with `encodeURIComponent` (matches
  `medline-source.ts`).
- **Credentials are env + `0600` sidecar, not keychain.** OS-keychain storage was an
  explicit non-goal (ADR-2). If per-OS-account isolation is ever needed, that is a
  deliberate follow-up, not a quick swap.
- **Remaining spec work (S3).** The `WhoopSyncAdapter`, record→`HealthObservation`
  mapping, persistence (incl. a persisted/idempotent sync cursor), and the
  `bober medical whoop sync` CLI are Sprint 3 — this sprint touches none of them.
