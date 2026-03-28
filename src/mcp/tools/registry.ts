// ── Tool Registry ───────────────────────────────────────────────────

/**
 * A JSON Schema object for describing a tool's input parameters.
 */
export interface JsonSchemaObject {
  type: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
  [key: string]: unknown;
}

export interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  [key: string]: unknown;
}

/**
 * Definition of a single MCP tool that agent-bober exposes.
 */
export interface BoberToolDefinition {
  /** The tool name as it will appear in tools/list (e.g. "bober_ping"). */
  name: string;
  /** Human-readable description of what the tool does. */
  description: string;
  /** JSON Schema object describing the tool's input parameters. */
  inputSchema: JsonSchemaObject;
  /** Function that executes the tool and returns a string result. */
  handler: (args: Record<string, unknown>) => Promise<string>;
}

// ── Registry implementation ─────────────────────────────────────────

const registry = new Map<string, BoberToolDefinition>();

/**
 * Register a tool in the global tool registry.
 * If a tool with the same name is already registered, it is overwritten.
 */
export function registerTool(tool: BoberToolDefinition): void {
  registry.set(tool.name, tool);
}

/**
 * Returns all registered tool definitions.
 */
export function getAllTools(): BoberToolDefinition[] {
  return Array.from(registry.values());
}

/**
 * Looks up a tool by name. Returns undefined if not found.
 */
export function getTool(name: string): BoberToolDefinition | undefined {
  return registry.get(name);
}
