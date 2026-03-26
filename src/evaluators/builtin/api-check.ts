import type {
  EvaluatorPlugin,
  EvalContext,
  EvalResult,
  EvalDetail,
  BoberConfig,
  SprintContract,
} from "../plugin-interface.js";

// ── Types ──────────────────────────────────────────────────────────

interface EndpointSpec {
  method: string;
  path: string;
  expectedStatus: number;
  body?: unknown;
  headers?: Record<string, string>;
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Infer API endpoints from the sprint contract description and
 * expected changes. This is a best-effort heuristic.
 */
function inferEndpointsFromContract(contract: SprintContract): EndpointSpec[] {
  const endpoints: EndpointSpec[] = [];

  // Look for REST-like patterns in the contract text.
  const allText = [
    contract.description,
    ...contract.successCriteria.map((c) => c.description),
    ...contract.expectedChanges.map((c) => c.description),
  ].join("\n");

  // Match patterns like "GET /api/users", "POST /api/items"
  const httpPattern = /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)/gi;
  let match: RegExpExecArray | null;

  while ((match = httpPattern.exec(allText)) !== null) {
    const method = match[1].toUpperCase();
    const path = match[2];
    // Default expected status based on method.
    const expectedStatus = method === "POST" ? 201 : 200;

    endpoints.push({ method, path, expectedStatus });
  }

  return endpoints;
}

/**
 * Make an HTTP request and return status + response body text.
 * Uses built-in fetch (available in Node 18+).
 */
async function makeRequest(
  baseUrl: string,
  spec: EndpointSpec,
  timeout: number,
): Promise<{ status: number; body: string; ok: boolean }> {
  const url = new URL(spec.path, baseUrl).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      method: spec.method,
      headers: {
        "Content-Type": "application/json",
        ...spec.headers,
      },
      body: spec.body ? JSON.stringify(spec.body) : undefined,
      signal: controller.signal,
    });

    const body = await response.text();
    return { status: response.status, body, ok: response.ok };
  } finally {
    clearTimeout(timer);
  }
}

// ── Evaluator ──────────────────────────────────────────────────────

const DEFAULT_PER_REQUEST_TIMEOUT_MS = 10_000;

export class ApiCheckEvaluator implements EvaluatorPlugin {
  readonly name = "API Check";
  readonly description = "Verifies API endpoints respond with expected status codes and shapes.";

  async canRun(_projectRoot: string, _config: BoberConfig): Promise<boolean> {
    // API check can run if the strategy config includes endpoints
    // or the contract mentions API paths. We return true optimistically
    // and let evaluate() handle the specifics.
    return true;
  }

  async evaluate(context: EvalContext): Promise<EvalResult> {
    const { strategy, contract } = context;
    const timestamp = new Date().toISOString();
    const perRequestTimeout =
      (strategy.config?.timeout as number) ?? DEFAULT_PER_REQUEST_TIMEOUT_MS;
    const baseUrl = (strategy.config?.baseUrl as string) ?? "http://localhost:3000";

    // Collect endpoints from config or infer from contract.
    const configEndpoints = (strategy.config?.endpoints as EndpointSpec[] | undefined) ?? [];
    const inferredEndpoints =
      configEndpoints.length === 0 ? inferEndpointsFromContract(contract) : [];

    const endpoints = [...configEndpoints, ...inferredEndpoints];

    if (endpoints.length === 0) {
      return {
        evaluator: this.name,
        passed: true,
        score: 100,
        details: [
          {
            criterion: "API endpoint detection",
            passed: true,
            message: "No API endpoints to check (none configured or inferred).",
            severity: "info",
          },
        ],
        summary: "No API endpoints to verify.",
        feedback: "No API endpoints were found in the strategy config or sprint contract.",
        timestamp,
      };
    }

    const details: EvalDetail[] = [];
    let passedCount = 0;

    for (const endpoint of endpoints) {
      try {
        const result = await makeRequest(baseUrl, endpoint, perRequestTimeout);
        const statusMatches = result.status === endpoint.expectedStatus;

        if (statusMatches) {
          passedCount++;
          details.push({
            criterion: `${endpoint.method} ${endpoint.path}`,
            passed: true,
            message: `Status ${result.status} (expected ${endpoint.expectedStatus})`,
            severity: "info",
          });
        } else {
          details.push({
            criterion: `${endpoint.method} ${endpoint.path}`,
            passed: false,
            message: `Status ${result.status}, expected ${endpoint.expectedStatus}. Body: ${result.body.slice(0, 200)}`,
            severity: "error",
          });
        }
      } catch (err) {
        details.push({
          criterion: `${endpoint.method} ${endpoint.path}`,
          passed: false,
          message: `Request failed: ${err instanceof Error ? err.message : String(err)}`,
          severity: "error",
        });
      }
    }

    const total = endpoints.length;
    const allPassed = passedCount === total;
    const score = total === 0 ? 100 : Math.round((passedCount / total) * 100);

    return {
      evaluator: this.name,
      passed: allPassed,
      score,
      details,
      summary: `API Check: ${passedCount}/${total} endpoints passed.`,
      feedback: this.buildFeedback(allPassed, details),
      timestamp,
    };
  }

  private buildFeedback(allPassed: boolean, details: EvalDetail[]): string {
    if (allPassed) return "All API endpoints responded as expected.";

    const failures = details.filter((d) => !d.passed);
    const lines = ["The following API endpoints did not respond as expected:", ""];
    for (const f of failures) {
      lines.push(`  ${f.criterion}: ${f.message}`);
    }
    return lines.join("\n");
  }
}

/**
 * Factory function for the registry.
 */
export function createApiCheckEvaluator(): EvaluatorPlugin {
  return new ApiCheckEvaluator();
}
