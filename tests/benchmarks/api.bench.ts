/**
 * API layer benchmarks.
 *
 * All measurements are in-process without running actual HTTP servers.  We
 * benchmark the routing decision, auth middleware logic, and pagination
 * math directly so results are deterministic and CI-stable.
 *
 * What is measured:
 *   - Gateway routing latency — service URL resolution from a request path
 *   - JWT validation overhead — jose verifyJWT call on a pre-signed token
 *   - API key lookup overhead — hash computation + map lookup
 *   - Pagination performance — cursor computation at various page sizes
 *
 * The JWT benchmark uses the HS256 algorithm which is the default for
 * OnePlatform deployments (OP_JWT_ALGORITHM=HS256).  A real deployment key
 * is generated in-process for the duration of the benchmark suite.
 */

import { createHmac, randomBytes, createHash } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { runBenchmark, type BenchmarkResult } from "./framework.js";

// ---------------------------------------------------------------------------
// Gateway routing latency
//
// Replicates the SERVICE_MAP lookup from proxy-service.ts without importing
// the module (which reads process.env at load time and may log warnings when
// env vars are absent).
// ---------------------------------------------------------------------------

const SERVICE_MAP: Record<string, string> = {
  auth: "http://auth-service:3000",
  connectors: "http://ingestion-service:3000",
  "webhooks/inbound": "http://ingestion-service:3000",
  uploads: "http://ingestion-service:3000",
  ontology: "http://ontology-service:3000",
  pipelines: "http://pipeline-service:3000",
  "pipeline-runs": "http://pipeline-service:3000",
  schedules: "http://pipeline-service:3000",
  exec: "http://execution-service:3000",
  apps: "http://app-service:3000",
  logs: "http://logging-service:3000",
  "audit-events": "http://logging-service:3000",
  plugins: "http://plugin-service:3000",
  roles: "http://auth-service:3000",
  users: "http://auth-service:3000",
};

/**
 * Resolve the upstream service URL from an inbound request path.
 *
 * Mirrors the proxy-service.ts resolution algorithm: strip /api/v1/, split on
 * /, try progressively shorter prefixes to handle compound keys like
 * "webhooks/inbound" before falling back to the first segment.
 */
function resolveUpstreamUrl(path: string): string | undefined {
  // Strip the /api/v1/ prefix
  const stripped = path.replace(/^\/api\/v\d+\//, "");
  const segments = stripped.split("/");

  // Try longest-to-shortest prefix matching (handles compound route keys)
  for (let len = segments.length; len >= 1; len--) {
    const prefix = segments.slice(0, len).join("/");
    if (SERVICE_MAP[prefix] !== undefined) {
      return SERVICE_MAP[prefix];
    }
  }

  return undefined;
}

// Representative sample of request paths the gateway receives on every
// request.  Covers all service prefixes and compound-key paths.
const SAMPLE_PATHS = [
  "/api/v1/auth/login",
  "/api/v1/connectors/abc-123/syncs",
  "/api/v1/pipelines/pipe-xyz/runs",
  "/api/v1/webhooks/inbound/hook-abc",
  "/api/v1/ontology/entities?cursor=abc&limit=50",
  "/api/v1/plugins/plug-123/hooks",
  "/api/v1/logs?level=error&limit=100",
  "/api/v1/users/me",
];

async function gatewayRoutingBenchmark(): Promise<BenchmarkResult> {
  let pathIdx = 0;

  return runBenchmark(
    "api/gateway-routing-latency",
    () => {
      // Cycle through paths to prevent the engine from optimising a single
      // constant lookup into a single branch.
      const path = SAMPLE_PATHS[pathIdx % SAMPLE_PATHS.length] ?? SAMPLE_PATHS[0]!;
      pathIdx++;
      resolveUpstreamUrl(path);
    },
    { iterations: 50_000, warmupIterations: 1_000, concurrency: 1 },
  );
}

// ---------------------------------------------------------------------------
// JWT validation overhead — measures jose jwtVerify cost
// ---------------------------------------------------------------------------

// 256-bit secret is the recommended minimum for HS256.
const JWT_SECRET = randomBytes(32);
const JWT_SECRET_KEY = new Uint8Array(JWT_SECRET);

async function issueTestJwt(userId: string, tenantId: string): Promise<string> {
  return new SignJWT({
    sub: userId,
    tid: tenantId,
    roles: ["developer"],
    scopes: ["data:read", "pipelines:read"],
    ev: true,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .setJti(randomBytes(16).toString("hex"))
    .sign(JWT_SECRET_KEY);
}

async function jwtValidationBenchmark(): Promise<BenchmarkResult> {
  // Pre-sign a token once; the benchmark measures only the verify path.
  const token = await issueTestJwt("user-bench-001", "tenant-bench");

  return runBenchmark(
    "api/jwt-validation-overhead",
    async () => {
      await jwtVerify(token, JWT_SECRET_KEY, { algorithms: ["HS256"] });
    },
    { iterations: 2_000, warmupIterations: 100, concurrency: 1 },
  );
}

// ---------------------------------------------------------------------------
// API key lookup overhead
//
// The API key middleware hashes the raw key with SHA-256 and does a Map
// lookup.  We measure both the hash computation and the lookup together since
// both happen on every authenticated request.
// ---------------------------------------------------------------------------

function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

async function apiKeyLookupBenchmark(): Promise<BenchmarkResult> {
  // Pre-populate a map with 1 000 hashed keys to simulate a busy tenant
  // where many API keys have been issued.  The benchmark key is guaranteed
  // to be in the map so we measure the full happy-path lookup cost.
  const keyStore = new Map<string, { tenantId: string; roles: string[] }>();
  const rawBenchKey = `op_live_${randomBytes(24).toString("hex")}`;
  const hashedBenchKey = hashApiKey(rawBenchKey);

  for (let i = 0; i < 1_000; i++) {
    const k = `op_live_${randomBytes(24).toString("hex")}`;
    keyStore.set(hashApiKey(k), { tenantId: "tenant-bench", roles: ["developer"] });
  }
  keyStore.set(hashedBenchKey, { tenantId: "tenant-bench", roles: ["developer"] });

  return runBenchmark(
    "api/api-key-lookup-overhead",
    () => {
      const hash = hashApiKey(rawBenchKey);
      keyStore.get(hash);
    },
    { iterations: 10_000, warmupIterations: 500, concurrency: 1 },
  );
}

// ---------------------------------------------------------------------------
// Pagination performance at various page sizes
//
// Cursor-based pagination is the primary list pattern across all API
// endpoints.  We benchmark the cursor decoding, item slicing, and
// next-cursor generation logic that runs on every paginated GET.
// ---------------------------------------------------------------------------

interface PaginationResult<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

function applyPagination<T extends { id: string }>(
  allItems: T[],
  cursor: string | undefined,
  limit: number,
): PaginationResult<T> {
  if (limit < 1 || limit > 1_000) {
    throw new Error(`Invalid pagination limit: ${limit}. Must be 1–1000.`);
  }

  const startIdx =
    cursor !== undefined
      ? allItems.findIndex((item) => item.id === cursor) + 1
      : 0;

  const page = allItems.slice(startIdx, startIdx + limit);
  const nextCursor =
    startIdx + limit < allItems.length
      ? (page[page.length - 1]?.id ?? null)
      : null;

  return { items: page, nextCursor, total: allItems.length };
}

async function paginationBenchmark(pageSize: number, datasetSize: number): Promise<BenchmarkResult> {
  // Build a fixed dataset and a cursor pointing to roughly the middle of it
  // so the benchmark exercises both the findIndex and the slice.
  const dataset = Array.from({ length: datasetSize }, (_, i) => ({
    id: `item-${i.toString().padStart(8, "0")}`,
    value: i,
  }));

  const midCursor = dataset[Math.floor(datasetSize / 2)]?.id;

  return runBenchmark(
    `api/pagination-page-${pageSize}-dataset-${datasetSize}`,
    () => {
      applyPagination(dataset, midCursor, pageSize);
    },
    { iterations: 5_000, warmupIterations: 200, concurrency: 1 },
  );
}

// ---------------------------------------------------------------------------
// HMAC request-signing overhead
//
// Some internal service-to-service calls use HMAC-signed tokens.  Measure
// the signing cost so we can track regressions in auth middleware.
// ---------------------------------------------------------------------------

async function hmacSigningBenchmark(): Promise<BenchmarkResult> {
  const signingKey = randomBytes(32).toString("hex");
  const payload = JSON.stringify({
    requestId: "req-bench-001",
    tenantId: "tenant-bench",
    issuedAt: Math.floor(Date.now() / 1000),
  });

  return runBenchmark(
    "api/hmac-signing-overhead",
    () => {
      createHmac("sha256", signingKey).update(payload).digest("hex");
    },
    { iterations: 20_000, warmupIterations: 500, concurrency: 1 },
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runApiBenchmarks(): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];

  results.push(await gatewayRoutingBenchmark());
  results.push(await jwtValidationBenchmark());
  results.push(await apiKeyLookupBenchmark());

  // Pagination at 3 page sizes × 2 dataset sizes
  results.push(await paginationBenchmark(10, 1_000));
  results.push(await paginationBenchmark(50, 1_000));
  results.push(await paginationBenchmark(100, 10_000));

  results.push(await hmacSigningBenchmark());

  return results;
}
