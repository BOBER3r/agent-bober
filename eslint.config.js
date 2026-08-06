import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: {
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        URL: "readonly",
        Response: "readonly",
        fetch: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    // Sprint 28: network egress guard for telemetry module (local-only invariant).
    // Any import of a network/socket module inside src/telemetry/ is a lint error.
    files: ["src/telemetry/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "undici", message: "Network access forbidden in telemetry module (Sprint 28 — local-only)" },
            { name: "got", message: "Network access forbidden in telemetry module" },
            { name: "axios", message: "Network access forbidden in telemetry module" },
            { name: "node-fetch", message: "Network access forbidden in telemetry module" },
          ],
          patterns: [
            {
              group: ["http", "https", "net", "tls", "dgram", "node:http", "node:https", "node:net", "node:tls", "node:dgram"],
              message: "Network/socket imports forbidden in src/telemetry/ — Sprint 28 local-only guarantee",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "Network access forbidden in telemetry module" },
      ],
    },
  },
  {
    // Sprint 6 (ADR-6): code-enforced zero-egress for the medical tree.
    // Any network/socket import inside src/medical/ is a lint error EXCEPT in the one
    // sanctioned retrieval file (src/medical/retrieval/medline-source.ts) — see override below.
    files: ["src/medical/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "undici",     message: "Network access forbidden in medical module (ADR-6 — zero-egress default)" },
            { name: "got",        message: "Network access forbidden in medical module" },
            { name: "axios",      message: "Network access forbidden in medical module" },
            { name: "node-fetch", message: "Network access forbidden in medical module" },
          ],
          patterns: [
            {
              group: ["http", "https", "net", "tls", "dgram", "node:http", "node:https", "node:net", "node:tls", "node:dgram"],
              message: "Network/socket imports forbidden in src/medical/ — ADR-6 egress only via the sanctioned retrieval file",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "Network access forbidden in medical module — egress only via the sanctioned retrieval file" },
      ],
    },
  },
  {
    // ADR-6 exceptions: the TWO designated network files (medline-source.ts for MedlinePlus; whoop-client.ts for WHOOP).
    files: ["src/medical/retrieval/medline-source.ts", "src/medical/whoop/whoop-client.ts"],
    rules: {
      "no-restricted-imports": "off",
      "no-restricted-globals": "off",
    },
  },
  {
    // Sprint 1 (PGE / ADR-2): module-graph boundary for the topology layer.
    // Zero node execution during topology validation is a property of the module graph,
    // not of an assertion — nothing in the topology layer may import an executor.
    //
    // The fileset covers the layer's SHARED ROOT (src/contracts/topology.ts) as well as
    // src/pge/topology/**: topology.ts is imported by every file in the guarded subtree,
    // so leaving it unguarded left a one-hop route to the orchestrator.
    files: ["src/pge/topology/**/*.ts", "src/contracts/topology.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/pge/runtime/**",
                "**/pge/nodes/**",
                "**/pge/registry/**",
                "**/pge/engine/**",
                "**/pge/compile/**",
                "../runtime/**",
                "../nodes/**",
                "../registry/**",
                "../engine/**",
                "../compile/**",
                "./runtime/**",
                "./nodes/**",
              ],
              message:
                "the topology layer must not import the graph runtime, node bodies, registries or the compiler — ADR-2 module-graph boundary (zero execution during validation)",
            },
            {
              group: [
                "**/orchestrator/**",
                "../orchestrator/**",
                "../../orchestrator/**",
                "../../../orchestrator/**",
              ],
              message:
                "the topology layer must not import src/orchestrator/ — ADR-2 module-graph boundary (zero execution during validation)",
            },
            {
              group: [
                "**/providers/**",
                "../providers/**",
                "../../providers/**",
                "../../../providers/**",
              ],
              message:
                "the topology layer must not import src/providers/ — ADR-2 module-graph boundary (no LLM call during validation)",
            },
            {
              // The root barrel re-exports the orchestrator pipeline, the agentic loop and
              // every provider adapter, so a single legal-looking import of it drags the
              // whole executor into the guarded subtree.
              group: ["**/src/index.js", "../index.js", "../../index.js", "../../../index.js"],
              message:
                "the topology layer must not import the root barrel (src/index.ts re-exports the orchestrator and every provider adapter) — ADR-2 module-graph boundary; import the specific contract module instead",
            },
            {
              // `node:child_process` is the PRIMITIVE; `execa` is what this repository
              // actually spawns with (a first-class runtime dependency), so blocking only
              // the primitive left the boundary open — see src/pge/lint-boundary.test.ts,
              // which lints each of these sources as a fixture and fails if it is allowed.
              group: [
                "child_process",
                "node:child_process",
                "worker_threads",
                "node:worker_threads",
                "vm",
                "node:vm",
                "cluster",
                "node:cluster",
                "execa",
                "execa/**",
                "cross-spawn",
                "tinyexec",
                "zx",
                // `createRequire` re-opens CommonJS resolution, which would let any of the
                // above back in past a static-import rule.
                "module",
                "node:module",
              ],
              message:
                "the topology layer must not spawn a process, a worker or a VM context, and must not reach CommonJS resolution — ADR-2 module-graph boundary (validation is pure). `execa` is this repo's process spawner, not just node:child_process.",
            },
            {
              // src/graph/** and src/discovery/** both import execa and spawn processes
              // (src/graph/cli.ts, src/graph/mcp-client.ts, src/graph/prereq.ts,
              // src/discovery/scanner.ts), so they are execution-capable layers even
              // though their names read as read-only analysis.
              group: [
                "**/utils/git.js",
                "**/fleet/**",
                "**/mcp/**",
                "**/cli/**",
                "**/workflow/**",
                "**/chat/**",
                "**/teams/**",
                "**/evaluators/**",
                "**/graph/**",
                "../graph/**",
                "../../graph/**",
                "../../../graph/**",
                "**/discovery/**",
                "../discovery/**",
                "../../discovery/**",
                "../../../discovery/**",
              ],
              message:
                "the topology layer must not import an execution-capable layer (cli, fleet, mcp, workflow, chat, teams, evaluators, git, graph, discovery) — ADR-2 module-graph boundary; src/graph/ and src/discovery/ transitively spawn processes via execa",
            },
          ],
        },
      ],
      // `no-restricted-imports` only sees STATIC ImportDeclarations — it never visits an
      // ImportExpression, so `await import("execa")` walked straight through the boundary
      // above. Dynamic import is banned outright in this layer rather than enumerated:
      // the topology layer is data plus pure functions and has no need of it.
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message:
            "the topology layer must not use dynamic import() — it bypasses the no-restricted-imports boundary (ADR-2 module-graph boundary)",
        },
        {
          selector: "CallExpression[callee.name='require']",
          message:
            "the topology layer must not use require() — it bypasses the no-restricted-imports boundary (ADR-2 module-graph boundary)",
        },
        {
          selector: "CallExpression[callee.name='createRequire']",
          message:
            "the topology layer must not use createRequire() — it bypasses the no-restricted-imports boundary (ADR-2 module-graph boundary)",
        },
      ],
    },
  },
  {
    // ── SandboxRunner is the only spawner a node body may reach ──
    //
    // Node bodies declare what they do to the world as an effect tag, and the topology's
    // `sandbox-exec` tag asserts that a node's process execution goes through
    // `SandboxRunner` — under a config-derived allowlist, the runner's own denylist, cwd
    // confinement and a kill timeout. Nothing in the TYPE system ties the tag to the
    // runner, so without this rule a node could declare `sandbox-exec` and then spawn
    // whatever it liked directly, and the tag would be a comment.
    //
    // This makes the claim a property of the MODULE GRAPH instead: the only outbound
    // execution routes from src/pge/nodes/ are ../runtime/sandbox.js and ../../utils/git.js
    // (the latter only from the commit path, whose node declares the gated `git` effect).
    //
    // The `ignores` clause is load-bearing: node TESTS legitimately import
    // node:child_process and use dynamic import() to spawn real child processes and to
    // probe module behaviour. The boundary binds production node bodies, which is where
    // the effect tag is declared.
    files: ["src/pge/nodes/**/*.ts"],
    ignores: ["src/pge/nodes/**/*.test.ts", "src/pge/nodes/__fixtures__/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "child_process",
                "node:child_process",
                "worker_threads",
                "node:worker_threads",
                "vm",
                "node:vm",
                "cluster",
                "node:cluster",
                "execa",
                "execa/**",
                "cross-spawn",
                "tinyexec",
                "zx",
                // `createRequire` re-opens CommonJS resolution, which would let any of the
                // above back in past a static-import rule.
                "module",
                "node:module",
              ],
              message:
                "a PGE node body must not spawn a process directly — route it through SandboxRunner (src/pge/runtime/sandbox.ts), which is what the `sandbox-exec` effect tag asserts. `process-exec` remains the gated deploy tag and is not a licence to import a spawner.",
            },
            {
              // src/graph/** and src/discovery/** spawn via execa (src/graph/cli.ts,
              // mcp-client.ts, prereq.ts, src/discovery/scanner.ts), so importing either
              // is a TRANSITIVE route around the direct-spawner group above. No production
              // node body imports them today; naming them keeps it that way.
              group: [
                "**/graph/**",
                "../graph/**",
                "../../graph/**",
                "**/discovery/**",
                "../discovery/**",
                "../../discovery/**",
              ],
              message:
                "a PGE node body must not import src/graph/ or src/discovery/ — both spawn processes via execa, which is a transitive route around the spawner boundary. Route process execution through SandboxRunner.",
            },
          ],
        },
      ],
      // `no-restricted-imports` only sees STATIC ImportDeclarations — it never visits an
      // ImportExpression, so `await import("execa")` would walk straight through the
      // boundary above.
      "no-restricted-syntax": [
        "error",
        {
          selector: "ImportExpression",
          message:
            "a PGE node body must not use dynamic import() — it bypasses the spawner boundary; route process execution through SandboxRunner",
        },
        {
          selector: "CallExpression[callee.name='require']",
          message:
            "a PGE node body must not use require() — it bypasses the spawner boundary; route process execution through SandboxRunner",
        },
        {
          selector: "CallExpression[callee.name='createRequire']",
          message:
            "a PGE node body must not use createRequire() — it bypasses the spawner boundary; route process execution through SandboxRunner",
        },
      ],
    },
  },
  {
    // Node.js globals for plain .js fixtures (e.g. src/fleet/__fixtures__/stub-child.js)
    files: ["src/**/*.js"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
      },
    },
  },
  {
    ignores: ["dist/", "node_modules/", "templates/"],
  },
];
