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
