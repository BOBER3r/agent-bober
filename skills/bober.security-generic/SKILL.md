---
name: bober.security-generic
description: "Generic OWASP/CWE security signature library shared across every stack-specific security skill. Not a workflow skill -- a data file of discrete vulnerable/safe code signature blocks read by SecuritySignatureParser. Covers injection, SSRF, XSS, secret handling, missing authorization (BOLA), insecure deserialization, weak randomness, prototype pollution/SSTI, log injection, mass assignment, and weak crypto."
---

# bober.security-generic — Generic Security Signature Library

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

### sql-injection
- **Title:** SQL injection via string concatenation
- **CWE:** CWE-89
- **Severity:** critical
- **VulnClass:** injection
- **Invariant:** User-controlled values never reach a SQL statement as raw string content — always via a parameterized placeholder.
- **Keywords:** sql, query, concat, raw, template-literal

**Unsafe:**
```ts
const rows = await db.query(`SELECT * FROM users WHERE id = ${req.query.id}`);
```

**Safe:**
```ts
const rows = await db.query("SELECT * FROM users WHERE id = $1", [req.query.id]);
```

### command-injection
- **Title:** OS command injection via shell interpolation
- **CWE:** CWE-78
- **Severity:** critical
- **VulnClass:** injection
- **Invariant:** User-controlled values never reach a shell string; child processes are spawned with an argv array and no shell.
- **Keywords:** exec, shell, spawn, child_process

**Unsafe:**
```ts
exec(`ping ${host}`, callback);
```

**Safe:**
```ts
execFile("ping", [host], callback);
```

### path-traversal
- **Title:** Path traversal in file read
- **CWE:** CWE-22
- **Severity:** high
- **VulnClass:** path-traversal
- **Invariant:** A resolved file path must stay within its declared base directory before any fs call touches it.
- **Keywords:** fs, readFile, path.join, traversal, dotdot

**Unsafe:**
```ts
const data = await fs.readFile(path.join(baseDir, req.query.file));
```

**Safe:**
```ts
const resolved = path.resolve(baseDir, req.query.file);
if (!resolved.startsWith(path.resolve(baseDir) + path.sep)) throw new Error("invalid path");
const data = await fs.readFile(resolved);
```

### ssrf-outbound-fetch
- **Title:** SSRF via unvalidated outbound URL
- **CWE:** CWE-918
- **Severity:** high
- **VulnClass:** ssrf
- **Invariant:** Outbound requests to a user-supplied URL are checked against an allowlist and blocked for RFC1918/loopback/link-local targets at the connection layer, not just by string inspection.
- **Keywords:** fetch, axios, ssrf, outbound, url

**Unsafe:**
```ts
const res = await fetch(req.body.url);
```

**Safe:**
```ts
assertAllowedHost(new URL(req.body.url)); // blocks RFC1918, 169.254.169.254, loopback
const res = await fetch(req.body.url, { dispatcher: pinnedDnsDispatcher });
```

### reflected-xss
- **Title:** XSS via unescaped HTML sink
- **CWE:** CWE-79
- **Severity:** high
- **VulnClass:** xss
- **Invariant:** User-controlled content never reaches an HTML sink (innerHTML, dangerouslySetInnerHTML, v-html) without escaping or sanitization.
- **Keywords:** innerHTML, dangerouslySetInnerHTML, xss, sanitize

**Unsafe:**
```ts
el.innerHTML = userComment;
```

**Safe:**
```ts
el.textContent = userComment;
```

### hardcoded-secret
- **Title:** Hard-coded credential or API key
- **CWE:** CWE-798
- **Severity:** critical
- **VulnClass:** secret-handling
- **Invariant:** Credentials and API keys are never literal source-code strings — they are loaded from environment variables or a secrets manager at runtime.
- **Keywords:** api-key, secret, credential, hardcoded

**Unsafe:**
```ts
const apiKey = "sk-live-abc123def456";
```

**Safe:**
```ts
const apiKey = mustGetEnv("API_KEY"); // fails fast if unset, never checked into source
```

### missing-authz-bola
- **Title:** Missing ownership check on ID-to-DB lookup (BOLA)
- **CWE:** CWE-862
- **Severity:** high
- **VulnClass:** idor-bola
- **Invariant:** Every object fetched or mutated by a client-supplied id is filtered by the requesting session's ownership, not just its existence.
- **Keywords:** bola, idor, ownerid, authorization

**Unsafe:**
```ts
const order = await Order.findById(req.params.id);
return res.json(order);
```

**Safe:**
```ts
const order = await Order.findOne({ _id: req.params.id, ownerId: req.session.userId });
if (!order) return res.status(404).end();
return res.json(order);
```

### insecure-deserialization
- **Title:** Unsafe deserialization of tainted data
- **CWE:** CWE-502
- **Severity:** critical
- **VulnClass:** deserialization
- **Invariant:** Tainted input is only ever parsed with a schema-validated JSON.parse — never passed to a deserializer, vm context, or dynamic code evaluator.
- **Keywords:** deserialize, unserialize, vm, new-function, eval

**Unsafe:**
```ts
const obj = vm.runInNewContext(req.body.payload);
```

**Safe:**
```ts
const obj = payloadSchema.parse(JSON.parse(req.body.payload));
```

### weak-randomness
- **Title:** Predictable RNG for a security-sensitive value
- **CWE:** CWE-338
- **Severity:** high
- **VulnClass:** insecure-randomness
- **Invariant:** Tokens, session ids, and other security-sensitive values are generated from a CSPRNG, never Math.random().
- **Keywords:** math.random, token, session-id, csprng

**Unsafe:**
```ts
const token = Math.random().toString(36).slice(2);
```

**Safe:**
```ts
const token = crypto.randomBytes(32).toString("hex");
```

### prototype-pollution
- **Title:** Prototype pollution via recursive merge
- **CWE:** CWE-1321
- **Severity:** high
- **VulnClass:** input-validation
- **Invariant:** A recursive merge/clone of user-controlled objects rejects __proto__/constructor/prototype keys before assigning any property.
- **Keywords:** prototype-pollution, merge, deep-merge, __proto__

**Unsafe:**
```ts
deepMerge(config, req.body);
```

**Safe:**
```ts
deepMerge(config, req.body, { blockedKeys: ["__proto__", "constructor", "prototype"] });
```

### ssti
- **Title:** Server-side template injection
- **CWE:** CWE-94
- **Severity:** critical
- **VulnClass:** injection
- **Invariant:** User-controlled input is passed to a template as data, never compiled as template source.
- **Keywords:** ssti, template, eval, render

**Unsafe:**
```ts
const html = ejs.render(userSuppliedTemplate, data);
```

**Safe:**
```ts
const html = precompiledTemplate(data); // template source is fixed, never user-supplied
```

### log-injection-crlf
- **Title:** CRLF / log injection
- **CWE:** CWE-117
- **Severity:** medium
- **VulnClass:** audit-logging
- **Invariant:** User-controlled values written to a log line have CR/LF stripped or encoded before concatenation, so a single log entry cannot be forged into multiple.
- **Keywords:** crlf, log-injection, logger, newline

**Unsafe:**
```ts
logger.info("login attempt user=" + req.body.username);
```

**Safe:**
```ts
logger.info("login attempt", { user: req.body.username.replace(/[\r\n]/g, "") });
```

### mass-assignment
- **Title:** Mass assignment / bulk property assignment (BOPLA)
- **CWE:** CWE-915
- **Severity:** high
- **VulnClass:** input-validation
- **Invariant:** A model update accepts only an explicit allowlist of client-writable fields, never the raw request body.
- **Keywords:** mass-assignment, bopla, allowlist, update

**Unsafe:**
```ts
await User.update(req.body, { where: { id: req.session.userId } });
```

**Safe:**
```ts
const { name, email } = req.body;
await User.update({ name, email }, { where: { id: req.session.userId } });
```

### weak-crypto-hash
- **Title:** Weak hash for password or integrity check
- **CWE:** CWE-327
- **Severity:** medium
- **VulnClass:** crypto-weakness
- **Invariant:** Passwords are hashed with a slow, salted algorithm (argon2/bcrypt); integrity checks use a modern digest (SHA-256+), never md5/sha1.
- **Keywords:** md5, sha1, password-hash, crypto-weakness

**Unsafe:**
```ts
const hash = crypto.createHash("md5").update(password).digest("hex");
```

**Safe:**
```ts
const hash = await argon2.hash(password);
```
