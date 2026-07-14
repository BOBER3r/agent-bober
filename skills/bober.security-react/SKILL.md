---
name: bober.security-react
description: "React client-side security signature library. Not a workflow skill -- a data file of discrete vulnerable/safe code signature blocks read by SecuritySignatureParser. Covers XSS via dangerouslySetInnerHTML/innerHTML/document.write, secrets committed into the client bundle, client-side-only trust of security decisions, unsafe href/redirect, postMessage without origin checks, and prototype pollution via client-side deep merge of untrusted input."
---

# bober.security-react — React Client-Side Security Signature Library

This skill is a **signature-library** file, not a workflow skill. It is read (as raw
markdown text) by `SecuritySignatureParser.parse()`
(`src/orchestrator/security-knowledge/parser.ts`) and turned into typed
`SecuritySignature[]` records used by the security-audit agent team. Do not confuse this
with `bober.security-audit`, which is the audit *workflow* skill, or with
`skills/bober.react/SKILL.md`, which is the unrelated React *framework* skill.

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

### react.dangerously-set-inner-html
- **Title:** XSS via dangerouslySetInnerHTML with variable input
- **CWE:** CWE-79
- **Severity:** critical
- **VulnClass:** xss
- **Invariant:** `dangerouslySetInnerHTML` is never given HTML built from unsanitized user-controlled data — either the content is rendered as text or it is passed through a sanitizer first.
- **Keywords:** dangerouslySetInnerHTML, XSS, __html, DOMPurify, sanitize

**Unsafe:**
```tsx
<div dangerouslySetInnerHTML={{ __html: userBio }} />
```

**Safe:**
```tsx
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(userBio) }} />
```

### react.raw-innerhtml-documentwrite
- **Title:** XSS via innerHTML / document.write with variable input
- **CWE:** CWE-79
- **Severity:** critical
- **VulnClass:** xss
- **Invariant:** DOM content derived from user-controlled data is assigned via `textContent` or a sanitized render path — `innerHTML` and `document.write` are never given unsanitized user input.
- **Keywords:** innerHTML, document.write, XSS, textContent, DOM

**Unsafe:**
```ts
el.innerHTML = new URLSearchParams(location.search).get("q");
```

**Safe:**
```ts
el.textContent = new URLSearchParams(location.search).get("q");
```

### react.secret-in-client-bundle
- **Title:** Secret / API key committed into the client bundle
- **CWE:** CWE-798
- **Severity:** critical
- **VulnClass:** secret-handling
- **Invariant:** A secret credential is never referenced from client-side code or a `REACT_APP_`/build-time env var that ships in the bundle — secret-gated calls are proxied through a server that holds the credential.
- **Keywords:** API key, client bundle, secret, process.env, REACT_APP

**Unsafe:**
```ts
const stripeSecretKey = process.env.REACT_APP_STRIPE_SECRET_KEY; // bundled into client JS, extractable
```

**Safe:**
```ts
// client never holds the secret key; it calls a server endpoint that holds it
const res = await fetch("/api/create-payment-intent", { method: "POST", body: JSON.stringify(order) });
```

### react.client-trusted-authz
- **Title:** Security decision trusted client-side (must be enforced server-side)
- **CWE:** CWE-602
- **Severity:** critical
- **VulnClass:** authn-authz
- **Invariant:** A UI element being conditionally rendered based on a client-held flag is never the sole enforcement of an authorization decision — the server independently re-checks authorization on every request the action triggers.
- **Keywords:** client-side, isAdmin, authorization, trust boundary, server

**Unsafe:**
```tsx
{user.isAdmin && <AdminPanel />} // server trusts any request that reaches the admin API
```

**Safe:**
```tsx
{user.isAdmin && <AdminPanel />} // UI hint only; server middleware independently requires an admin role
```

### react.unsafe-href-redirect
- **Title:** Unsafe href / open redirect (javascript: scheme / attacker-controlled target)
- **CWE:** CWE-601
- **Severity:** high
- **VulnClass:** input-validation
- **Invariant:** A URL used as a link target or redirect destination is validated against an allowed scheme and, for redirects, an allowlist of same-origin/known paths before use — an attacker-controlled `javascript:` URI or arbitrary external redirect target is never followed.
- **Keywords:** href, javascript:, open redirect, location, next, allowlist

**Unsafe:**
```tsx
<a href={userSuppliedUrl}>Visit</a>
```

**Safe:**
```tsx
const safeUrl = /^https?:\/\//.test(userSuppliedUrl) ? userSuppliedUrl : "#";
<a href={safeUrl}>Visit</a>
```

### react.postmessage-no-origin
- **Title:** postMessage handler without origin check
- **CWE:** CWE-346
- **Severity:** high
- **VulnClass:** input-validation
- **Invariant:** A `message` event listener always verifies `event.origin` against an allowlist before acting on `event.data` — a message from an unexpected origin is never processed.
- **Keywords:** postMessage, message event, origin, onmessage, allowlist

**Unsafe:**
```ts
window.addEventListener("message", (event) => { runCommand(event.data); });
```

**Safe:**
```ts
window.addEventListener("message", (event) => {
  if (!ALLOWED_ORIGINS.includes(event.origin)) return;
  runCommand(event.data);
});
```

### react.prototype-pollution-deepmerge
- **Title:** Prototype pollution via client-side deep merge of untrusted input
- **CWE:** CWE-1321
- **Severity:** high
- **VulnClass:** input-validation
- **Invariant:** A deep-merge of parsed untrusted JSON always rejects or strips `__proto__`, `constructor`, and `prototype` keys before merging — object state derived from untrusted input never reaches `Object.prototype`.
- **Keywords:** prototype pollution, __proto__, deep merge, constructor, JSON.parse

**Unsafe:**
```ts
const merged = deepMerge(state, JSON.parse(untrustedResponse)); // "__proto__" key pollutes Object.prototype
```

**Safe:**
```ts
function safeDeepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    target[key] = source[key];
  }
  return target;
}
const merged = safeDeepMerge(state, JSON.parse(untrustedResponse));
```

### react.token-in-localstorage
- **Title:** Auth token stored in localStorage (XSS-exfiltratable)
- **CWE:** CWE-922
- **Severity:** high
- **VulnClass:** secret-handling
- **Invariant:** An authentication token is stored in an httpOnly cookie inaccessible to JavaScript — it is never written to `localStorage`/`sessionStorage`, where any XSS on the page can read and exfiltrate it.
- **Keywords:** localStorage, JWT, token, httpOnly, XSS exfiltration

**Unsafe:**
```ts
localStorage.setItem("jwt", token); // any injected script can read this
```

**Safe:**
```ts
// server sets the token as an httpOnly, Secure, SameSite cookie on login;
// the client never touches the token value directly
```
