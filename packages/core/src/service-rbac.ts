// Service RBAC permission matrix — compiled at build time.
// To change permissions: edit this file, rebuild @oneplatform/core, redeploy all services.
// Runtime modification is intentionally impossible (spec §4, §5, ADR-19).

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface RbacRule {
  target: string;    // target service name
  method: HttpMethod | "*";
  // Exact path or prefix ending in * (e.g. "/internal/plugins/*/bundle")
  // Use * as a path to match all paths on the target service.
  pathPattern: string;
}

// Each entry grants a specific caller the listed rules. No entry = no outbound calls.
// Wildcards in pathPattern are path-segment wildcards (match one segment only).
const MATRIX: Record<string, RbacRule[]> = {
  // gateway-service is the sole external entry point and may call all internal services.
  "gateway-service": [
    { target: "*", method: "*", pathPattern: "*" },
  ],

  // ingestion-service outbound calls (spec §4 RBAC matrix)
  "ingestion-service": [
    { target: "ontology-service",  method: "POST", pathPattern: "/internal/ontology/map" },
    { target: "ontology-service",  method: "POST", pathPattern: "/internal/ontology/infer" },
    { target: "pipeline-service",  method: "POST", pathPattern: "/internal/pipeline/trigger" },
    { target: "execution-service", method: "POST", pathPattern: "/internal/execution/connector-run" },
    { target: "plugin-service",    method: "GET",  pathPattern: "/internal/plugins/connectors" },
  ],

  // ontology-service outbound calls
  "ontology-service": [
    { target: "execution-service", method: "POST", pathPattern: "/internal/execution/run" },
  ],

  // pipeline-service outbound calls
  "pipeline-service": [
    { target: "execution-service", method: "POST", pathPattern: "/internal/execution/run" },
    { target: "ontology-service",  method: "GET",  pathPattern: "/internal/ontology/schema" },
    { target: "plugin-service",    method: "GET",  pathPattern: "/internal/plugins/hooks" },
  ],

  // app-service outbound calls
  "app-service": [
    { target: "auth-service",      method: "GET",  pathPattern: "/internal/auth/validate" },
    { target: "auth-service",      method: "POST", pathPattern: "/internal/auth/guest-sessions" },
    { target: "auth-service",      method: "POST", pathPattern: "/internal/oauth/clients" },
    { target: "ontology-service",  method: "GET",  pathPattern: "/internal/ontology/schema" },
    { target: "pipeline-service",  method: "POST", pathPattern: "/internal/pipeline/trigger" },
    { target: "execution-service", method: "POST", pathPattern: "/internal/execution/run" },
    { target: "logging-service",   method: "GET",  pathPattern: "/internal/logging/query" },
    { target: "plugin-service",    method: "GET",  pathPattern: "/internal/plugins/widgets" },
  ],

  // execution-service outbound calls
  "execution-service": [
    // Path pattern uses * to match any plugin ID segment: /internal/plugins/{id}/bundle
    { target: "plugin-service", method: "GET", pathPattern: "/internal/plugins/*/bundle" },
  ],

  // logging-service: receive-only, no outbound calls
  // auth-service: no outbound calls

  // plugin-service outbound calls
  "plugin-service": [
    { target: "execution-service", method: "POST",   pathPattern: "/internal/execution/run" },
    { target: "execution-service", method: "POST",   pathPattern: "/internal/execution/plugin-drain" },
    { target: "execution-service", method: "POST",   pathPattern: "/internal/execution/plugin-cache-invalidate" },
    { target: "ingestion-service", method: "POST",   pathPattern: "/internal/ingestion/connectors" },
    // DELETE /internal/ingestion/connectors/{id} — {id} matched by *
    { target: "ingestion-service", method: "DELETE", pathPattern: "/internal/ingestion/connectors/*" },
  ],
};

// matchesPattern checks whether a concrete URL path matches a rule's pathPattern.
// Supports a single trailing wildcard segment ("*") or a mid-path wildcard segment.
// Examples:
//   "/internal/plugins/*/bundle" matches "/internal/plugins/abc-123/bundle"
//   "/internal/ingestion/connectors/*" matches "/internal/ingestion/connectors/abc-123"
//   "*" matches anything
function matchesPattern(pattern: string, path: string): boolean {
  if (pattern === "*") return true;
  if (!pattern.includes("*")) return pattern === path;

  // Split both into segments and match segment-by-segment
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");

  if (patternParts.length !== pathParts.length) return false;

  return patternParts.every((part, i) => part === "*" || part === pathParts[i]);
}

// isServiceCallAllowed is the single enforcement point for the service RBAC matrix.
// Called by the serviceAuth middleware on every internal request.
export function isServiceCallAllowed(
  callerService: string,
  targetService: string,
  method: string,
  path: string
): boolean {
  const rules = MATRIX[callerService];
  if (!rules) return false;

  return rules.some((rule) => {
    // Wildcard target means the caller may call any service
    const targetMatches = rule.target === "*" || rule.target === targetService;
    const methodMatches = rule.method === "*" || rule.method === method;
    const pathMatches = matchesPattern(rule.pathPattern, path);
    return targetMatches && methodMatches && pathMatches;
  });
}
