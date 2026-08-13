// ── bober_contracts tool ──────────────────────────────────────────────
//
// No args -> list all contracts with id, feature, status, dependsOn.
// With { contractId } -> return the full contract JSON.

import { cwd } from "node:process";

import { listContractsWithSkips, loadContract } from "../../state/index.js";
import { registerTool } from "./registry.js";

// ── Registration ─────────────────────────────────────────────────────

export function registerContractsTool(): void {
  registerTool({
    name: "bober_contracts",
    description:
      "List all sprint contracts or read a specific contract. " +
      "Without arguments returns a summary list of all contracts (id, feature, status, dependsOn). " +
      "With contractId returns the full contract JSON including success criteria and evaluator feedback.",
    inputSchema: {
      type: "object",
      properties: {
        contractId: {
          type: "string",
          description:
            "Contract ID to read. Omit to list all contracts.",
        },
      },
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const projectRoot = cwd();
      const contractId =
        typeof args.contractId === "string" && args.contractId.trim()
          ? args.contractId.trim()
          : undefined;

      // Return full contract when contractId is provided
      if (contractId !== undefined) {
        try {
          const contract = await loadContract(projectRoot, contractId);
          return JSON.stringify(contract, null, 2);
        } catch (err) {
          return JSON.stringify(
            {
              error: `Contract "${contractId}" not found.`,
              details:
                err instanceof Error ? err.message : String(err),
            },
            null,
            2,
          );
        }
      }

      // List mode.
      //
      // Reports BOTH halves of the directory. A contract file that does not
      // parse is skipped — one bad file must not break the listing — but it is
      // named here rather than dropped, because a caller told "you have N
      // contracts" has no way to tell that number apart from the number of
      // files actually on disk. On this repository the two differ by 52.
      const { contracts, skipped } = await listContractsWithSkips(projectRoot);

      const unreadable =
        skipped.length > 0
          ? {
              unreadable: {
                count: skipped.length,
                note:
                  `${skipped.length} contract file(s) in .bober/contracts/ did not parse and are NOT ` +
                  `included in the list above. They are on disk; they do not satisfy the current ` +
                  `SprintContractSchema. Use bober_contracts with a contractId to see the full error.`,
                files: skipped.map((s) => s.file),
              },
            }
          : {};

      if (contracts.length === 0) {
        return JSON.stringify(
          {
            contracts: [],
            message:
              "No contracts found. Run bober_plan first to generate sprint contracts.",
            ...unreadable,
          },
          null,
          2,
        );
      }

      const summary = contracts.map((c) => ({
        contractId: c.contractId,
        title: c.title,
        status: c.status,
        dependsOn: c.dependsOn,
      }));

      return JSON.stringify({ contracts: summary, ...unreadable }, null, 2);
    },
  });
}
