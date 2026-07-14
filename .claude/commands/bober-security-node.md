---
name: bober.security-node
description: "Node/Express backend security signature library. Not a workflow skill -- a data file of discrete vulnerable/safe code signature blocks read by SecuritySignatureParser. Covers SQL/NoSQL injection, ORM raw escape hatches, command injection, path traversal, SSRF, BOLA, mass assignment (BOPLA), BFLA, insecure deserialization, vm-as-sandbox misuse, hardcoded/logged secrets, and JWT/session weaknesses."
---

# bober.security-node — Node/Express Backend Security Signature Library

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

### node.sql-injection
- **Title:** SQL injection via string concatenation / template literal
- **CWE:** CWE-89
- **Severity:** critical
- **VulnClass:** injection
- **Invariant:** A SQL query built from request-derived data always uses parameterized placeholders — the query text is never built by concatenating or interpolating untrusted input.
- **Keywords:** sql, query, concat, template-literal, parameterized

**Unsafe:**
```ts
const rows = await db.query(`SELECT * FROM users WHERE id = ${req.query.id}`);
```

**Safe:**
```ts
const rows = await db.query("SELECT * FROM users WHERE id = $1", [req.query.id]);
```

### node.orm-raw-escape-hatch
- **Title:** ORM raw escape hatch (.raw/.literal/$queryRawUnsafe/$where) with interpolated input
- **CWE:** CWE-89
- **Severity:** critical
- **VulnClass:** injection
- **Invariant:** When an ORM's raw-SQL escape hatch is used, the query text is a static tagged template or the ORM's own bound-parameter form — request-derived values are never string-concatenated into it.
- **Keywords:** ORM, raw, $queryRawUnsafe, literal, $where, prisma, knex

**Unsafe:**
```ts
await prisma.$queryRawUnsafe(`SELECT * FROM users WHERE name = '${req.query.name}'`);
```

**Safe:**
```ts
await prisma.$queryRaw`SELECT * FROM users WHERE name = ${req.query.name}`;
```

### node.command-injection
- **Title:** OS command injection via exec / shell:true
- **CWE:** CWE-78
- **Severity:** critical
- **VulnClass:** injection
- **Invariant:** A subprocess is spawned with an explicit binary and an argument array, never through a shell, so request-derived data cannot be interpreted as shell syntax.
- **Keywords:** exec, child_process, shell, execFile, command

**Unsafe:**
```ts
exec(`convert ${req.body.file} out.png`);
```

**Safe:**
```ts
execFile("convert", [req.body.file, "out.png"]);
```

### node.path-traversal
- **Title:** Path traversal via path.join/resolve with no boundary assertion
- **CWE:** CWE-22
- **Severity:** high
- **VulnClass:** path-traversal
- **Invariant:** A file path built from a request-supplied name is resolved and asserted to remain inside the intended base directory before any filesystem access.
- **Keywords:** path.join, path.resolve, traversal, ../, boundary

**Unsafe:**
```ts
const filePath = path.join(baseDir, req.params.name);
await fs.readFile(filePath);
```

**Safe:**
```ts
const filePath = path.resolve(baseDir, req.params.name);
if (!filePath.startsWith(path.resolve(baseDir) + path.sep)) throw new Error("invalid path");
await fs.readFile(filePath);
```

### node.ssrf-outbound-fetch
- **Title:** SSRF via unvalidated outbound fetch/axios (cloud metadata / RFC1918)
- **CWE:** CWE-918
- **Severity:** critical
- **VulnClass:** ssrf
- **Invariant:** An outbound HTTP request to a user-supplied URL is only made after the resolved host is checked against an allowlist and internal/link-local address ranges are blocked at connect time.
- **Keywords:** ssrf, fetch, axios, 169.254.169.254, RFC1918, metadata

**Unsafe:**
```ts
const res = await fetch(req.body.url);
```

**Safe:**
```ts
assertAllowedOutboundHost(req.body.url); // rejects RFC1918 / 169.254.169.254 / non-allowlisted hosts
const res = await fetch(req.body.url);
```

### node.bola-missing-ownership
- **Title:** BOLA: object id looked up with no owner predicate
- **CWE:** CWE-639
- **Severity:** critical
- **VulnClass:** idor-bola
- **Invariant:** A lookup by object id is always scoped to the requesting session's owner id in the query itself — the object is never fetched by id alone and checked afterward.
- **Keywords:** BOLA, IDOR, ownerId, object id, authorization

**Unsafe:**
```ts
const doc = await db.query("SELECT * FROM documents WHERE id = $1", [req.params.id]);
```

**Safe:**
```ts
const doc = await db.query(
  "SELECT * FROM documents WHERE id = $1 AND owner_id = $2",
  [req.params.id, req.session.userId],
);
```

### node.mass-assignment-bopla
- **Title:** BOPLA / mass assignment via Model.update(req.body)
- **CWE:** CWE-915
- **Severity:** critical
- **VulnClass:** idor-bola
- **Invariant:** An update from request data only writes an explicit allowlist of updatable fields — the raw request body is never passed directly to a model update call.
- **Keywords:** mass assignment, BOPLA, req.body, allowlist, isAdmin

**Unsafe:**
```ts
await User.update(req.body, { where: { id: req.session.userId } });
```

**Safe:**
```ts
const { name, email } = req.body; // explicit allowlist, excludes isAdmin/role/etc.
await User.update({ name, email }, { where: { id: req.session.userId } });
```

### node.bfla-admin-no-role-gate
- **Title:** BFLA: admin/privileged route with no role gate
- **CWE:** CWE-862
- **Severity:** critical
- **VulnClass:** authn-authz
- **Invariant:** A route performing a privileged function is always guarded by a role check that runs before the handler executes — the function-level authorization is never assumed from the route existing under an "/admin" prefix.
- **Keywords:** BFLA, admin route, role, requireRole, authorization

**Unsafe:**
```ts
app.post("/admin/users/:id/delete", async (req, res) => { await deleteUser(req.params.id); });
```

**Safe:**
```ts
app.post("/admin/users/:id/delete", requireRole("admin"), async (req, res) => {
  await deleteUser(req.params.id);
});
```

### node.insecure-deserialization
- **Title:** Insecure deserialization of untrusted input
- **CWE:** CWE-502
- **Severity:** critical
- **VulnClass:** deserialization
- **Invariant:** Untrusted input is only decoded with a format-safe parser (plain JSON, or a YAML loader restricted to a safe schema) — a deserializer capable of reconstructing arbitrary objects or executing code is never applied to request data.
- **Keywords:** deserialization, unserialize, yaml.load, node-serialize, gadget

**Unsafe:**
```ts
const obj = serialize.unserialize(req.body.payload); // node-serialize: gadget chain -> RCE
```

**Safe:**
```ts
const obj = JSON.parse(req.body.payload); // or yaml.load(input, { schema: JSON_SCHEMA })
```

### node.vm-not-a-sandbox
- **Title:** vm/new Function/eval on tainted input (vm is not a sandbox)
- **CWE:** CWE-94
- **Severity:** critical
- **VulnClass:** injection
- **Invariant:** Request-derived strings are never passed to eval, new Function, or Node's built-in vm module as executable code — vm does not provide a security boundary against untrusted code.
- **Keywords:** vm, vm2, new Function, eval, runInNewContext, sandbox

**Unsafe:**
```ts
const result = new vm.Script(req.body.code).runInNewContext({});
```

**Safe:**
```ts
// never eval untrusted input; use a real out-of-process sandbox (worker with no
// filesystem/network access) plus an explicit allowlist of permitted operations
const result = await runInIsolatedWorker(req.body.code, { allowlist: SAFE_OPS });
```

### node.secrets-hardcoded-logged
- **Title:** Hard-coded or logged secrets
- **CWE:** CWE-798
- **Severity:** high
- **VulnClass:** secret-handling
- **Invariant:** Credentials and API keys are read from environment variables or a secret manager at runtime and are never embedded as string literals or written to application logs.
- **Keywords:** secret, API key, hardcoded, logger, redact, .env

**Unsafe:**
```ts
const stripeKey = "sk_live_51H8x...";
logger.info("charging user", { apiKey: stripeKey, amount });
```

**Safe:**
```ts
const stripeKey = process.env.STRIPE_SECRET_KEY;
logger.info("charging user", { amount }); // secret never included in log fields
```

### node.jwt-alg-none
- **Title:** JWT alg:none / weak secret / session fixation
- **CWE:** CWE-347
- **Severity:** critical
- **VulnClass:** authn-authz
- **Invariant:** A JWT is verified with a pinned strong algorithm and a high-entropy secret or key, and a session identifier is rotated on every successful login — a token is never accepted with an attacker-chosen algorithm or a weak shared secret.
- **Keywords:** JWT, alg none, algorithms, session fixation, verify

**Unsafe:**
```ts
const payload = jwt.verify(token, secret, { algorithms: ["none", "HS256"] });
```

**Safe:**
```ts
const payload = jwt.verify(token, strongSecret, { algorithms: ["HS256"] });
req.session.regenerate(() => { req.session.userId = payload.sub; }); // rotate on login
```
