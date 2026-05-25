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
    ignores: ["dist/", "node_modules/", "templates/"],
  },
];
