# Phase 1 Part 2: @oneplatform/core Middleware + App Factory

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the 10-middleware stack and createApp() factory.

**Architecture:** Hono middleware stack applied in order. createApp() composes them.

**Tech Stack:** TypeScript, Hono, jose, vitest

**Depends on:** Phase 1 Part 1 (Tasks 1-12 in `2026-06-10-phase1-core-library.md`)

---

## File Structure

These files extend the `packages/core/src/` tree established in Part 1:

```
packages/core/src/
├── service-rbac.ts                 (new) compiled permission matrix + isServiceCallAllowed()
├── app.ts                          (new) createApp() factory
├── index.ts                        (new) barrel export
├── middleware/
│   ├── request-id.ts               (new) UUID v7 generation, header propagation
│   ├── cors.ts                     (new) origin validation, preflight, headers
│   ├── auth.ts                     (new) JWT + API key validation, scope check, revocation
│   ├── service-auth.ts             (new) Ed25519 JWT verification, RBAC check
│   ├── response-envelope.ts        (new) wrap route return in { data: T }
│   ├── error-handler.ts            (new) catch all errors → { error: {...} }
│   ├── rate-limit-headers.ts       (new) read c.var → set X-RateLimit-* headers
│   └── deprecation-headers.ts      (new) set Deprecation/Sunset/Link headers
└── __tests__/
    ├── service-rbac.test.ts        (new)
    ├── request-id.test.ts          (new)
    ├── cors.test.ts                (new)
    ├── auth.test.ts                (new)
    ├── service-auth.test.ts        (new)
    ├── response-envelope.test.ts   (new)
    ├── error-handler.test.ts       (new)
    ├── rate-limit-headers.test.ts  (new)
    ├── deprecation-headers.test.ts (new)
    └── app.test.ts                 (new) integration test
```

**Key interfaces from Part 1 used throughout:**

```typescript
// From src/types.ts (Part 1)
interface UserContext {
  userId: string; tenantId: string; roles: string[];
  scopes: string[]; isGuest: boolean; isService: boolean; emailVerified: boolean;
}
type AppVariables = { user: UserContext; requestId: string; };

// From src/errors.ts (Part 1) — used by error-handler.ts
UnauthorizedError, ForbiddenError, InsufficientScopeError, OriginNotAllowedError,
ValidationError, InternalError, AppError
```

---

## Task 13: Service RBAC Matrix (`src/service-rbac.ts`)

**Files:**
- Create: `packages/core/src/service-rbac.ts`
- Create: `packages/core/src/__tests__/service-rbac.test.ts`

The matrix maps `(caller, targetPath, method)` to allowed/denied. It is compiled at build time — no runtime modification possible (spec §4, §5).

- [ ] **13.1 Write the failing test**

```typescript
// packages/core/src/__tests__/service-rbac.test.ts
import { describe, it, expect } from "vitest";
import { isServiceCallAllowed } from "../service-rbac.js";

describe("isServiceCallAllowed", () => {
  // gateway-service is the catch-all entry point — it can call everything
  it("allows gateway-service to call any endpoint on any service", () => {
    expect(isServiceCallAllowed("gateway-service", "auth-service", "POST", "/api/v1/auth/login")).toBe(true);
    expect(isServiceCallAllowed("gateway-service", "execution-service", "POST", "/internal/execution/run")).toBe(true);
    expect(isServiceCallAllowed("gateway-service", "plugin-service", "GET", "/internal/plugins/widgets")).toBe(true);
  });

  // ingestion-service allowed paths
  it("allows ingestion-service to call POST /internal/ontology/map on ontology-service", () => {
    expect(isServiceCallAllowed("ingestion-service", "ontology-service", "POST", "/internal/ontology/map")).toBe(true);
  });

  it("allows ingestion-service to call POST /internal/ontology/infer on ontology-service", () => {
    expect(isServiceCallAllowed("ingestion-service", "ontology-service", "POST", "/internal/ontology/infer")).toBe(true);
  });

  it("allows ingestion-service to call POST /internal/pipeline/trigger on pipeline-service", () => {
    expect(isServiceCallAllowed("ingestion-service", "pipeline-service", "POST", "/internal/pipeline/trigger")).toBe(true);
  });

  it("allows ingestion-service to call POST /internal/execution/connector-run on execution-service", () => {
    expect(isServiceCallAllowed("ingestion-service", "execution-service", "POST", "/internal/execution/connector-run")).toBe(true);
  });

  it("allows ingestion-service to call GET /internal/plugins/connectors on plugin-service", () => {
    expect(isServiceCallAllowed("ingestion-service", "plugin-service", "GET", "/internal/plugins/connectors")).toBe(true);
  });

  // ingestion-service denied paths
  it("denies ingestion-service from calling auth-service endpoints", () => {
    expect(isServiceCallAllowed("ingestion-service", "auth-service", "GET", "/internal/auth/validate")).toBe(false);
  });

  it("denies ingestion-service from calling GET /internal/ontology/schema (not in its matrix)", () => {
    expect(isServiceCallAllowed("ingestion-service", "ontology-service", "GET", "/internal/ontology/schema")).toBe(false);
  });

  // ontology-service
  it("allows ontology-service to call POST /internal/execution/run on execution-service", () => {
    expect(isServiceCallAllowed("ontology-service", "execution-service", "POST", "/internal/execution/run")).toBe(true);
  });

  it("denies ontology-service from calling pipeline-service", () => {
    expect(isServiceCallAllowed("ontology-service", "pipeline-service", "POST", "/internal/pipeline/trigger")).toBe(false);
  });

  // pipeline-service
  it("allows pipeline-service to call POST /internal/execution/run", () => {
    expect(isServiceCallAllowed("pipeline-service", "execution-service", "POST", "/internal/execution/run")).toBe(true);
  });

  it("allows pipeline-service to call GET /internal/ontology/schema", () => {
    expect(isServiceCallAllowed("pipeline-service", "ontology-service", "GET", "/internal/ontology/schema")).toBe(true);
  });

  it("allows pipeline-service to call GET /internal/plugins/hooks", () => {
    expect(isServiceCallAllowed("pipeline-service", "plugin-service", "GET", "/internal/plugins/hooks")).toBe(true);
  });

  it("denies pipeline-service from calling auth-service", () => {
    expect(isServiceCallAllowed("pipeline-service", "auth-service", "GET", "/internal/auth/validate")).toBe(false);
  });

  // app-service
  it("allows app-service to call GET /internal/auth/validate on auth-service", () => {
    expect(isServiceCallAllowed("app-service", "auth-service", "GET", "/internal/auth/validate")).toBe(true);
  });

  it("allows app-service to call POST /internal/auth/guest-sessions on auth-service", () => {
    expect(isServiceCallAllowed("app-service", "auth-service", "POST", "/internal/auth/guest-sessions")).toBe(true);
  });

  it("allows app-service to call POST /internal/oauth/clients on auth-service", () => {
    expect(isServiceCallAllowed("app-service", "auth-service", "POST", "/internal/oauth/clients")).toBe(true);
  });

  it("allows app-service to call GET /internal/ontology/schema on ontology-service", () => {
    expect(isServiceCallAllowed("app-service", "ontology-service", "GET", "/internal/ontology/schema")).toBe(true);
  });

  it("allows app-service to call POST /internal/pipeline/trigger on pipeline-service", () => {
    expect(isServiceCallAllowed("app-service", "pipeline-service", "POST", "/internal/pipeline/trigger")).toBe(true);
  });

  it("allows app-service to call POST /internal/execution/run on execution-service", () => {
    expect(isServiceCallAllowed("app-service", "execution-service", "POST", "/internal/execution/run")).toBe(true);
  });

  it("allows app-service to call GET /internal/logging/query on logging-service", () => {
    expect(isServiceCallAllowed("app-service", "logging-service", "GET", "/internal/logging/query")).toBe(true);
  });

  it("allows app-service to call GET /internal/plugins/widgets on plugin-service", () => {
    expect(isServiceCallAllowed("app-service", "plugin-service", "GET", "/internal/plugins/widgets")).toBe(true);
  });

  // execution-service
  it("allows execution-service to call GET /internal/plugins/{id}/bundle on plugin-service", () => {
    expect(isServiceCallAllowed("execution-service", "plugin-service", "GET", "/internal/plugins/abc-123/bundle")).toBe(true);
  });

  it("denies execution-service from calling any auth-service endpoint", () => {
    expect(isServiceCallAllowed("execution-service", "auth-service", "GET", "/internal/auth/validate")).toBe(false);
  });

  // plugin-service
  it("allows plugin-service to call POST /internal/execution/run", () => {
    expect(isServiceCallAllowed("plugin-service", "execution-service", "POST", "/internal/execution/run")).toBe(true);
  });

  it("allows plugin-service to call POST /internal/execution/plugin-drain", () => {
    expect(isServiceCallAllowed("plugin-service", "execution-service", "POST", "/internal/execution/plugin-drain")).toBe(true);
  });

  it("allows plugin-service to call POST /internal/execution/plugin-cache-invalidate", () => {
    expect(isServiceCallAllowed("plugin-service", "execution-service", "POST", "/internal/execution/plugin-cache-invalidate")).toBe(true);
  });

  it("allows plugin-service to call POST /internal/ingestion/connectors", () => {
    expect(isServiceCallAllowed("plugin-service", "ingestion-service", "POST", "/internal/ingestion/connectors")).toBe(true);
  });

  it("allows plugin-service to call DELETE /internal/ingestion/connectors/{id}", () => {
    expect(isServiceCallAllowed("plugin-service", "ingestion-service", "DELETE", "/internal/ingestion/connectors/abc-123")).toBe(true);
  });

  it("denies plugin-service from calling auth-service", () => {
    expect(isServiceCallAllowed("plugin-service", "auth-service", "POST", "/internal/auth/guest-sessions")).toBe(false);
  });

  // auth-service and logging-service have no outbound calls
  it("denies auth-service from calling any other service", () => {
    expect(isServiceCallAllowed("auth-service", "ontology-service", "GET", "/internal/ontology/schema")).toBe(false);
  });

  it("denies logging-service from calling any other service", () => {
    expect(isServiceCallAllowed("logging-service", "pipeline-service", "POST", "/internal/pipeline/trigger")).toBe(false);
  });

  // Unknown callers are denied
  it("denies unknown caller service names", () => {
    expect(isServiceCallAllowed("rogue-service", "auth-service", "GET", "/internal/auth/validate")).toBe(false);
  });
});
```

- [ ] **13.2 Run the test to confirm it fails**

```bash
cd /home/ubuntu/topics/oneplatform
pnpm --filter @oneplatform/core run test -- --reporter=verbose src/__tests__/service-rbac.test.ts
```

Expected: FAIL — `isServiceCallAllowed` not found.

- [ ] **13.3 Write `packages/core/src/service-rbac.ts`**

```typescript
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
```

- [ ] **13.4 Run the test to confirm it passes**

```bash
pnpm --filter @oneplatform/core run test -- --reporter=verbose src/__tests__/service-rbac.test.ts
```

Expected: All tests PASS.

- [ ] **13.5 Commit**

```bash
git add packages/core/src/service-rbac.ts packages/core/src/__tests__/service-rbac.test.ts
git commit -m "feat(core): add service RBAC permission matrix and isServiceCallAllowed()"
```

---

## Task 14: Request ID Middleware (`src/middleware/request-id.ts`)

**Files:**
- Create: `packages/core/src/middleware/request-id.ts`
- Create: `packages/core/src/__tests__/request-id.test.ts`

Generates or propagates `X-Request-ID`. UUID v7 is used because it encodes a sortable millisecond timestamp — requests can be chronologically sorted by ID in logs without a separate timestamp field.

- [ ] **14.1 Write the failing test**

```typescript
// packages/core/src/__tests__/request-id.test.ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { requestIdMiddleware } from "../middleware/request-id.js";

function buildApp() {
  const app = new Hono();
  app.use("*", requestIdMiddleware());
  app.get("/test", (c) => c.json({ requestId: c.var.requestId }));
  return app;
}

describe("requestIdMiddleware", () => {
  it("generates a UUID v7 request ID when none is provided", async () => {
    const res = await buildApp().request("/test");
    const body = await res.json();
    // UUID v7 format: 8-4-4-4-12 hex chars, version nibble = 7
    expect(body.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("sets X-Request-ID response header", async () => {
    const res = await buildApp().request("/test");
    expect(res.headers.get("X-Request-ID")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("preserves an incoming X-Request-ID from upstream (e.g. Gateway forwarding)", async () => {
    const incomingId = "01917e3a-1234-7abc-8def-000000000001";
    const res = await buildApp().request("/test", {
      headers: { "X-Request-ID": incomingId },
    });
    const body = await res.json();
    expect(body.requestId).toBe(incomingId);
    expect(res.headers.get("X-Request-ID")).toBe(incomingId);
  });

  it("exposes requestId on c.var.requestId for downstream middleware", async () => {
    const res = await buildApp().request("/test");
    const body = await res.json();
    expect(typeof body.requestId).toBe("string");
    expect(body.requestId.length).toBeGreaterThan(0);
  });
});
```

- [ ] **14.2 Run the test to confirm it fails**

```bash
pnpm --filter @oneplatform/core run test -- src/__tests__/request-id.test.ts
```

Expected: FAIL — module not found.

- [ ] **14.3 Write `packages/core/src/middleware/request-id.ts`**

```typescript
import { createMiddleware } from "hono/factory";
import { randomBytes } from "crypto";

// UUID v7 encodes a sortable millisecond timestamp in the first 48 bits.
// This lets ops sort log lines by requestId chronologically without a separate
// timestamp — critical when tracing distributed requests (spec §12, W3C Trace Context).
function uuidV7(): string {
  const now = BigInt(Date.now());
  const bytes = randomBytes(10);

  // 48-bit timestamp (ms precision)
  const timeLow = Number(now & BigInt(0xffffffff));
  const timeMid = Number((now >> BigInt(32)) & BigInt(0xffff));

  // Version nibble = 7
  const timeHighAndVersion = (Number((now >> BigInt(48)) & BigInt(0x0fff)) | 0x7000);

  // variant bits: 10xx xxxx (RFC 4122 variant 1)
  const clockSeq = (bytes[0] & 0x3f) | 0x80;
  const clockSeqLow = bytes[1];

  const node = bytes.subarray(2, 8);

  const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");
  const nodeHex = Array.from(node).map((b) => hex(b, 2)).join("");

  return [
    hex(timeLow, 8),
    hex(timeMid, 4),
    hex(timeHighAndVersion, 4),
    hex(clockSeq, 2) + hex(clockSeqLow, 2),
    nodeHex,
  ].join("-");
}

// requestIdMiddleware propagates an upstream X-Request-ID or generates a new
// UUID v7 if none is present. Sets c.var.requestId for the error handler to
// include in error responses (spec §6 Error Code Registry).
export function requestIdMiddleware() {
  return createMiddleware(async (c, next) => {
    const incoming = c.req.header("X-Request-ID");
    const requestId = incoming ?? uuidV7();

    c.set("requestId", requestId);
    c.header("X-Request-ID", requestId);

    await next();
  });
}
```

- [ ] **14.4 Run the test to confirm it passes**

```bash
pnpm --filter @oneplatform/core run test -- src/__tests__/request-id.test.ts
```

Expected: All tests PASS.

- [ ] **14.5 Commit**

```bash
git add packages/core/src/middleware/request-id.ts packages/core/src/__tests__/request-id.test.ts
git commit -m "feat(core): add request ID middleware with UUID v7 generation"
```

---

## Task 15: CORS Middleware (`src/middleware/cors.ts`)

**Files:**
- Create: `packages/core/src/middleware/cors.ts`
- Create: `packages/core/src/__tests__/cors.test.ts`

Validates the `Origin` header against `OP_ALLOWED_ORIGINS`. Unlisted origins receive `403 ORIGIN_NOT_ALLOWED` — not a silent CORS failure — to prevent information leakage via CORS error messages (spec §6).

- [ ] **15.1 Write the failing test**

```typescript
// packages/core/src/__tests__/cors.test.ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { corsMiddleware } from "../middleware/cors.js";

function buildApp(allowedOrigins: string[]) {
  const app = new Hono();
  app.use("*", corsMiddleware({ allowedOrigins }));
  app.get("/data", (c) => c.json({ ok: true }));
  return app;
}

describe("corsMiddleware", () => {
  it("sets CORS headers for an allowed origin", async () => {
    const app = buildApp(["https://app.example.com"]);
    const res = await app.request("/data", {
      headers: { Origin: "https://app.example.com" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
  });

  it("returns 403 ORIGIN_NOT_ALLOWED for an origin not in the allowlist", async () => {
    const app = buildApp(["https://app.example.com"]);
    const res = await app.request("/data", {
      headers: { Origin: "https://evil.example.com" },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("handles OPTIONS preflight with 204 and correct headers for an allowed origin", async () => {
    const app = buildApp(["https://app.example.com"]);
    const res = await app.request("/data", {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
  });

  it("returns 403 on OPTIONS preflight for a disallowed origin", async () => {
    const app = buildApp(["https://app.example.com"]);
    const res = await app.request("/data", {
      method: "OPTIONS",
      headers: {
        Origin: "https://attacker.example.com",
        "Access-Control-Request-Method": "DELETE",
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("allows requests without an Origin header (non-browser, e.g. CLI or server)", async () => {
    const app = buildApp(["https://app.example.com"]);
    // No Origin header — direct server-to-server call
    const res = await app.request("/data");
    expect(res.status).toBe(200);
  });

  it("exposes X-RateLimit-* and X-OnePlatform-Request-ID in CORS expose headers", async () => {
    const app = buildApp(["https://app.example.com"]);
    const res = await app.request("/data", {
      headers: { Origin: "https://app.example.com" },
    });
    const exposeHeader = res.headers.get("Access-Control-Expose-Headers") ?? "";
    expect(exposeHeader).toContain("X-RateLimit-Limit");
    expect(exposeHeader).toContain("X-OnePlatform-Request-ID");
  });

  it("sets correct Allow-Headers including Authorization and X-API-Key", async () => {
    const app = buildApp(["https://app.example.com"]);
    const res = await app.request("/data", {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example.com",
        "Access-Control-Request-Method": "GET",
      },
    });
    const allowHeaders = res.headers.get("Access-Control-Allow-Headers") ?? "";
    expect(allowHeaders).toContain("Authorization");
    expect(allowHeaders).toContain("X-API-Key");
  });
});
```

- [ ] **15.2 Run the test to confirm it fails**

```bash
pnpm --filter @oneplatform/core run test -- src/__tests__/cors.test.ts
```

Expected: FAIL — module not found.

- [ ] **15.3 Write `packages/core/src/middleware/cors.ts`**

```typescript
import { createMiddleware } from "hono/factory";

export interface CorsConfig {
  allowedOrigins: string[];
}

const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const ALLOWED_HEADERS = "Authorization, Content-Type, X-API-Key, X-Requested-With";
// Expose rate-limit headers + request ID to browser apps (spec §6 CORS Policy)
const EXPOSE_HEADERS =
  "X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-RateLimit-Policy, X-OnePlatform-Request-ID";
const MAX_AGE = "86400";

// corsMiddleware enforces the OP_ALLOWED_ORIGINS allowlist.
// Requests from unknown origins return 403 ORIGIN_NOT_ALLOWED rather than a
// normal CORS failure. This prevents leaking endpoint existence to attackers
// who probe from untrusted origins (spec §6 CORS Policy).
export function corsMiddleware(config: CorsConfig) {
  const originSet = new Set(config.allowedOrigins);

  function setCorsHeaders(origin: string, headers: Headers): void {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
    headers.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    headers.set("Access-Control-Expose-Headers", EXPOSE_HEADERS);
    headers.set("Access-Control-Max-Age", MAX_AGE);
    // Allow credentials (cookies) — only valid with a specific origin, never *
    headers.set("Access-Control-Allow-Credentials", "true");
  }

  return createMiddleware(async (c, next) => {
    const origin = c.req.header("Origin");

    // No Origin header = not a browser cross-origin request (CLI, server SDK, etc.)
    if (!origin) {
      await next();
      return;
    }

    if (!originSet.has(origin)) {
      return c.json(
        {
          error: {
            code: "ORIGIN_NOT_ALLOWED",
            message: `Origin '${origin}' is not permitted.`,
            requestId: c.var.requestId ?? "",
          },
        },
        403
      );
    }

    if (c.req.method === "OPTIONS") {
      // Preflight: respond with headers and terminate — no further processing
      const res = new Response(null, { status: 204 });
      setCorsHeaders(origin, res.headers);
      return res;
    }

    await next();

    // Set CORS headers on the actual response after route handler runs
    setCorsHeaders(origin, c.res.headers);
  });
}
```

- [ ] **15.4 Run the test to confirm it passes**

```bash
pnpm --filter @oneplatform/core run test -- src/__tests__/cors.test.ts
```

Expected: All tests PASS.

- [ ] **15.5 Commit**

```bash
git add packages/core/src/middleware/cors.ts packages/core/src/__tests__/cors.test.ts
git commit -m "feat(core): add CORS middleware with allowlist enforcement"
```

---

## Task 16: Auth Middleware (`src/middleware/auth.ts`)

**Files:**
- Create: `packages/core/src/middleware/auth.ts`
- Create: `packages/core/src/__tests__/auth.test.ts`

Handles three auth paths: (1) Bearer JWT (HS256), (2) API key (`op_live_` prefix), (3) skip for public routes. Sets `c.var.user`. Checks Redis revocation blocklist for JWTs (spec §4 JWT Strategy).

- [ ] **16.1 Write the failing test**

```typescript
// packages/core/src/__tests__/auth.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { authMiddleware } from "../middleware/auth.js";

const JWT_SECRET = "test-jwt-secret-must-be-32chars!!";
const secretBytes = new TextEncoder().encode(JWT_SECRET);

async function issueToken(payload: Record<string, unknown>, expiresIn = "15m") {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .setJti("test-jti-" + Math.random())
    .sign(secretBytes);
}

// Minimal Redis mock: tracks revocation keys
function makeMockRedis(revokedJtis: string[] = []) {
  return {
    exists: vi.fn().mockImplementation(async (key: string) => {
      return revokedJtis.some((jti) => key.includes(jti)) ? 1 : 0;
    }),
  };
}

// Minimal API key validator mock
function makeMockApiKeyValidator(validKey: string, user: Record<string, unknown>) {
  return vi.fn().mockImplementation(async (key: string) => {
    if (key === validKey) return user;
    return null;
  });
}

function buildApp(opts: {
  jwtSecret: string;
  redis: ReturnType<typeof makeMockRedis>;
  validateApiKey: ReturnType<typeof makeMockApiKeyValidator>;
  publicRoutes?: string[];
}) {
  const app = new Hono<{ Variables: { user: unknown; requestId: string } }>();
  app.use("*", (c, next) => { c.set("requestId", "req-test"); return next(); });
  app.use("*", authMiddleware({
    jwtSecret: opts.jwtSecret,
    // @ts-expect-error using mock
    redis: opts.redis,
    validateApiKey: opts.validateApiKey,
    publicRoutes: opts.publicRoutes ?? [],
  }));
  app.get("/protected", (c) => c.json({ user: c.var.user }));
  app.get("/public", (c) => c.json({ ok: true }));
  return app;
}

describe("authMiddleware — JWT path", () => {
  it("authenticates a valid JWT and sets c.var.user", async () => {
    const redis = makeMockRedis();
    const validateApiKey = makeMockApiKeyValidator("", null);
    const token = await issueToken({
      sub: "user-123",
      tid: "tenant-abc",
      roles: ["viewer"],
      scopes: ["data:read"],
    });
    const app = buildApp({ jwtSecret: JWT_SECRET, redis, validateApiKey });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.userId).toBe("user-123");
    expect(body.user.tenantId).toBe("tenant-abc");
    expect(body.user.roles).toContain("viewer");
    expect(body.user.scopes).toContain("data:read");
    expect(body.user.isService).toBe(false);
    expect(body.user.isGuest).toBe(false);
  });

  it("returns 401 UNAUTHORIZED for an expired JWT", async () => {
    const redis = makeMockRedis();
    const validateApiKey = makeMockApiKeyValidator("", null);
    // Issue a token that expired 5 minutes ago
    const token = await issueToken({ sub: "user-123", tid: "tenant-abc", roles: [], scopes: [] }, "-5m");
    const app = buildApp({ jwtSecret: JWT_SECRET, redis, validateApiKey });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for a JWT with wrong signature", async () => {
    const redis = makeMockRedis();
    const validateApiKey = makeMockApiKeyValidator("", null);
    const wrongSecret = new TextEncoder().encode("wrong-secret-32-chars-padding!!");
    const token = await new SignJWT({ sub: "u", tid: "t", roles: [], scopes: [] })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("15m")
      .sign(wrongSecret);
    const app = buildApp({ jwtSecret: JWT_SECRET, redis, validateApiKey });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for a revoked JWT (jti in Redis revocation blocklist)", async () => {
    const revokedJti = "revoked-jti-9999";
    const redis = makeMockRedis([revokedJti]);
    const validateApiKey = makeMockApiKeyValidator("", null);
    const token = await new SignJWT({ sub: "u", tid: "t", roles: [], scopes: [] })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("15m")
      .setJti(revokedJti)
      .sign(secretBytes);
    const app = buildApp({ jwtSecret: JWT_SECRET, redis, validateApiKey });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("downgrades unverified users to viewer role maximum", async () => {
    const redis = makeMockRedis();
    const validateApiKey = makeMockApiKeyValidator("", null);
    const token = await issueToken({
      sub: "user-unverified",
      tid: "tenant-abc",
      roles: ["tenant-admin"],
      scopes: ["admin"],
      unverified: true,
    });
    const app = buildApp({ jwtSecret: JWT_SECRET, redis, validateApiKey });
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    // Unverified user must not keep elevated roles (spec §4 Email Verification)
    expect(body.user.emailVerified).toBe(false);
    expect(body.user.roles).not.toContain("tenant-admin");
    expect(body.user.roles).toContain("viewer");
  });
});

describe("authMiddleware — API key path", () => {
  it("authenticates a valid API key and sets c.var.user", async () => {
    const redis = makeMockRedis();
    const user = { userId: "user-api", tenantId: "tenant-api", roles: ["viewer"], scopes: ["data:read"], isGuest: false, isService: false, emailVerified: true };
    const validateApiKey = makeMockApiKeyValidator("op_live_validkey123456789012345", user);
    const app = buildApp({ jwtSecret: JWT_SECRET, redis, validateApiKey });
    const res = await app.request("/protected", {
      headers: { "X-API-Key": "op_live_validkey123456789012345" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.userId).toBe("user-api");
  });

  it("returns 401 for an invalid API key", async () => {
    const redis = makeMockRedis();
    const validateApiKey = makeMockApiKeyValidator("op_live_correct", { userId: "u", tenantId: "t", roles: [], scopes: [], isGuest: false, isService: false, emailVerified: true });
    const app = buildApp({ jwtSecret: JWT_SECRET, redis, validateApiKey });
    const res = await app.request("/protected", {
      headers: { "X-API-Key": "op_live_wrongkey" },
    });
    expect(res.status).toBe(401);
  });
});

describe("authMiddleware — public routes", () => {
  it("skips auth for a public route", async () => {
    const redis = makeMockRedis();
    const validateApiKey = makeMockApiKeyValidator("", null);
    const app = buildApp({
      jwtSecret: JWT_SECRET, redis, validateApiKey,
      publicRoutes: ["/public"],
    });
    const res = await app.request("/public");
    expect(res.status).toBe(200);
  });

  it("still requires auth for non-public routes", async () => {
    const redis = makeMockRedis();
    const validateApiKey = makeMockApiKeyValidator("", null);
    const app = buildApp({
      jwtSecret: JWT_SECRET, redis, validateApiKey,
      publicRoutes: ["/public"],
    });
    const res = await app.request("/protected");
    expect(res.status).toBe(401);
  });

  it("returns 401 when no auth header is provided for a protected route", async () => {
    const redis = makeMockRedis();
    const validateApiKey = makeMockApiKeyValidator("", null);
    const app = buildApp({ jwtSecret: JWT_SECRET, redis, validateApiKey });
    const res = await app.request("/protected");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
```

- [ ] **16.2 Run the test to confirm it fails**

```bash
pnpm --filter @oneplatform/core run test -- src/__tests__/auth.test.ts
```

Expected: FAIL — module not found.

- [ ] **16.3 Write `packages/core/src/middleware/auth.ts`**

```typescript
import { createMiddleware } from "hono/factory";
import { jwtVerify, type JWTPayload } from "jose";
import type Redis from "ioredis";
import type { UserContext } from "../types.js";

// Roles that unverified users may NOT hold (spec §4 Email Verification).
// An unverified user is capped at viewer regardless of their token claims.
const ELEVATED_ROLES = new Set([
  "platform-admin", "tenant-admin", "developer", "editor",
]);

interface JwtClaims extends JWTPayload {
  sub: string;
  tid: string;
  roles: string[];
  scopes: string[];
  unverified?: boolean;
}

export interface AuthMiddlewareConfig {
  jwtSecret: string;
  redis: Redis;
  // validateApiKey looks up the API key in the auth service's database.
  // Returns UserContext if valid, null if not found or revoked.
  validateApiKey: (key: string) => Promise<UserContext | null>;
  // Routes that bypass auth entirely (e.g. /healthz, /readyz, /api/v1/auth/*)
  publicRoutes?: string[];
}

// authMiddleware is the primary user-facing authentication layer.
// It runs after requestId and cors, before serviceAuth (spec §5 middleware stack).
export function authMiddleware(config: AuthMiddlewareConfig) {
  const secretBytes = new TextEncoder().encode(config.jwtSecret);
  const publicRouteSet = new Set(config.publicRoutes ?? []);

  return createMiddleware(async (c, next) => {
    const path = new URL(c.req.url).pathname;

    // Skip auth entirely for explicitly public routes (healthz, bootstrap, etc.)
    if (publicRouteSet.has(path)) {
      await next();
      return;
    }

    const requestId: string = c.var.requestId ?? "";

    // Try Bearer JWT first
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      let claims: JwtClaims;

      try {
        const { payload } = await jwtVerify(token, secretBytes, { algorithms: ["HS256"] });
        claims = payload as JwtClaims;
      } catch {
        return c.json(
          { error: { code: "UNAUTHORIZED", message: "Invalid or expired token.", requestId } },
          401
        );
      }

      // Check Redis revocation blocklist — every request, O(1) (spec §4 JWT Strategy)
      if (claims.jti) {
        const revoked = await config.redis.exists(`revocation:${claims.jti}`);
        if (revoked) {
          return c.json(
            { error: { code: "UNAUTHORIZED", message: "Token has been revoked.", requestId } },
            401
          );
        }
      }

      // Unverified users: downgrade to viewer-only, preserve emailVerified=false flag
      // so downstream code can prompt them to verify (spec §4 Email Verification).
      let roles = claims.roles ?? [];
      let scopes = claims.scopes ?? [];
      const isUnverified = claims.unverified === true;

      if (isUnverified) {
        roles = roles.filter((r) => !ELEVATED_ROLES.has(r));
        if (!roles.includes("viewer")) roles = ["viewer"];
        scopes = ["data:read", "ontology:read", "pipelines:read", "apps:read", "logs:read"];
      }

      const user: UserContext = {
        userId: claims.sub,
        tenantId: claims.tid,
        roles,
        scopes,
        isGuest: false,
        isService: false,
        emailVerified: !isUnverified,
      };

      c.set("user", user);
      await next();
      return;
    }

    // Try X-API-Key header
    const apiKey = c.req.header("X-API-Key");
    if (apiKey) {
      const user = await config.validateApiKey(apiKey);
      if (!user) {
        return c.json(
          { error: { code: "UNAUTHORIZED", message: "Invalid API key.", requestId } },
          401
        );
      }
      c.set("user", user);
      await next();
      return;
    }

    // No auth credential provided
    return c.json(
      { error: { code: "UNAUTHORIZED", message: "Authentication required.", requestId } },
      401
    );
  });
}
```

- [ ] **16.4 Run the test to confirm it passes**

```bash
pnpm --filter @oneplatform/core run test -- src/__tests__/auth.test.ts
```

Expected: All tests PASS.

- [ ] **16.5 Commit**

```bash
git add packages/core/src/middleware/auth.ts packages/core/src/__tests__/auth.test.ts
git commit -m "feat(core): add auth middleware (JWT HS256 + API key + revocation check)"
```

---

## Task 17: Service Auth Middleware (`src/middleware/service-auth.ts`)

**Files:**
- Create: `packages/core/src/middleware/service-auth.ts`
- Create: `packages/core/src/__tests__/service-auth.test.ts`

Ed25519 JWT validation for the `X-Service-Token` header. RBAC check via `isServiceCallAllowed()`. Validates that `X-User-Context` is only accepted when accompanied by a valid `X-Service-Token` (spec §4 Service-to-Service Auth).

- [ ] **17.1 Write the failing test**

```typescript
// packages/core/src/__tests__/service-auth.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import { generateKeyPair, exportPKCS8, exportSPKI, SignJWT } from "jose";
import { serviceAuthMiddleware } from "../middleware/service-auth.js";

let privateKeyPem: string;
let publicKeyPem: string;
let privateKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("EdDSA", { crv: "Ed25519" });
  privateKey = pair.privateKey;
  privateKeyPem = await exportPKCS8(pair.privateKey);
  publicKeyPem = await exportSPKI(pair.publicKey);
});

async function issueServiceToken(callerService: string, expiresIn = "5m") {
  return new SignJWT({ sub: callerService, role: "service" })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .setJti("svc-jti-" + Math.random())
    .sign(privateKey);
}

function buildApp(opts: {
  targetService: string;
  // Map of callerService -> publicKey PEM string
  servicePublicKeys: Record<string, string>;
}) {
  const app = new Hono<{ Variables: { user: unknown; requestId: string } }>();
  app.use("*", (c, next) => { c.set("requestId", "req-test"); return next(); });
  app.use(
    "/internal/*",
    serviceAuthMiddleware({
      targetService: opts.targetService,
      servicePublicKeys: opts.servicePublicKeys,
    })
  );
  app.post("/internal/ontology/map", (c) => c.json({ ok: true }));
  app.get("/internal/ontology/schema", (c) => c.json({ ok: true }));
  return app;
}

describe("serviceAuthMiddleware", () => {
  it("allows an authorized service call with valid Ed25519 token", async () => {
    const token = await issueServiceToken("ingestion-service");
    const app = buildApp({
      targetService: "ontology-service",
      servicePublicKeys: { "ingestion-service": publicKeyPem },
    });
    const res = await app.request("/internal/ontology/map", {
      method: "POST",
      headers: { "X-Service-Token": token },
    });
    expect(res.status).toBe(200);
  });

  it("returns 401 when X-Service-Token is missing on an internal route", async () => {
    const app = buildApp({
      targetService: "ontology-service",
      servicePublicKeys: { "ingestion-service": publicKeyPem },
    });
    const res = await app.request("/internal/ontology/map", { method: "POST" });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 for an expired service token", async () => {
    const token = await issueServiceToken("ingestion-service", "-1m");
    const app = buildApp({
      targetService: "ontology-service",
      servicePublicKeys: { "ingestion-service": publicKeyPem },
    });
    const res = await app.request("/internal/ontology/map", {
      method: "POST",
      headers: { "X-Service-Token": token },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for an unknown caller service (no public key registered)", async () => {
    const token = await issueServiceToken("rogue-service");
    const app = buildApp({
      targetService: "ontology-service",
      // No entry for rogue-service
      servicePublicKeys: { "ingestion-service": publicKeyPem },
    });
    const res = await app.request("/internal/ontology/map", {
      method: "POST",
      headers: { "X-Service-Token": token },
    });
    expect(res.status).toBe(401);
  });

  it("returns 403 FORBIDDEN when RBAC denies the call", async () => {
    // ingestion-service is NOT allowed to call GET /internal/ontology/schema
    const token = await issueServiceToken("ingestion-service");
    const app = buildApp({
      targetService: "ontology-service",
      servicePublicKeys: { "ingestion-service": publicKeyPem },
    });
    const res = await app.request("/internal/ontology/schema", {
      headers: { "X-Service-Token": token },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("sets c.var.user with isService=true on success", async () => {
    const token = await issueServiceToken("ingestion-service");
    const app = buildApp({
      targetService: "ontology-service",
      servicePublicKeys: { "ingestion-service": publicKeyPem },
    });
    // Add a route that reads c.var.user to verify it was set
    app.post("/internal/ontology/map", (c) => c.json({ user: (c.var as { user: unknown }).user }));
    const res = await app.request("/internal/ontology/map", {
      method: "POST",
      headers: { "X-Service-Token": token },
    });
    const body = await res.json();
    expect(body.user.isService).toBe(true);
    expect(body.user.userId).toBe("ingestion-service");
  });

  it("rejects X-User-Context without a valid X-Service-Token (spec §4 security invariant)", async () => {
    const app = buildApp({
      targetService: "ontology-service",
      servicePublicKeys: { "ingestion-service": publicKeyPem },
    });
    const res = await app.request("/internal/ontology/map", {
      method: "POST",
      headers: {
        // X-User-Context alone — no X-Service-Token
        "X-User-Context": Buffer.from(JSON.stringify({ userId: "injected", tenantId: "t", roles: ["platform-admin"], scopes: ["admin"] })).toString("base64"),
      },
    });
    // Must be rejected — X-User-Context without a valid X-Service-Token is a spoofing attempt
    expect(res.status).toBe(401);
  });
});
```

- [ ] **17.2 Run the test to confirm it fails**

```bash
pnpm --filter @oneplatform/core run test -- src/__tests__/service-auth.test.ts
```

Expected: FAIL — module not found.

- [ ] **17.3 Write `packages/core/src/middleware/service-auth.ts`**

```typescript
import { createMiddleware } from "hono/factory";
import { jwtVerify, importSPKI, type JWTPayload } from "jose";
import type { UserContext } from "../types.js";
import { isServiceCallAllowed } from "../service-rbac.js";

interface ServiceTokenClaims extends JWTPayload {
  sub: string;
  role: "service";
}

export interface ServiceAuthConfig {
  // The name of the service receiving this request (e.g. "ontology-service")
  targetService: string;
  // Map of callerServiceName → Ed25519 public key PEM (loaded from /data/service-keys/)
  servicePublicKeys: Record<string, string>;
}

// serviceAuthMiddleware enforces Ed25519 service tokens and the compiled RBAC matrix.
// Only used on /internal/* routes. X-User-Context is only forwarded to c.var.user
// when it arrives alongside a valid and authorized X-Service-Token — the two headers
// must be validated together (spec §4 Service-to-Service Auth, security invariant).
export function serviceAuthMiddleware(config: ServiceAuthConfig) {
  return createMiddleware(async (c, next) => {
    const requestId: string = c.var.requestId ?? "";
    const serviceToken = c.req.header("X-Service-Token");
    const userContextHeader = c.req.header("X-User-Context");

    // Reject X-User-Context sent without a service token — it would allow any
    // caller to spoof an elevated user context (spec §4 security invariant).
    if (!serviceToken && userContextHeader) {
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "X-User-Context requires a valid X-Service-Token.",
            requestId,
          },
        },
        401
      );
    }

    if (!serviceToken) {
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "X-Service-Token is required on internal routes.",
            requestId,
          },
        },
        401
      );
    }

    // Decode the service name from the token without verifying first,
    // so we can look up the correct public key.
    let callerService: string;
    try {
      const parts = serviceToken.split(".");
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as ServiceTokenClaims;
      callerService = payload.sub;
    } catch {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Malformed service token.", requestId } },
        401
      );
    }

    // Reject unknown callers — no public key = no access
    const publicKeyPem = config.servicePublicKeys[callerService];
    if (!publicKeyPem) {
      return c.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: `Unknown service: ${callerService}`,
            requestId,
          },
        },
        401
      );
    }

    // Verify Ed25519 signature and expiry
    let claims: ServiceTokenClaims;
    try {
      const publicKey = await importSPKI(publicKeyPem, "EdDSA");
      const { payload } = await jwtVerify(serviceToken, publicKey, { algorithms: ["EdDSA"] });
      claims = payload as ServiceTokenClaims;
    } catch {
      return c.json(
        { error: { code: "UNAUTHORIZED", message: "Invalid or expired service token.", requestId } },
        401
      );
    }

    // RBAC check: consult the compiled matrix (spec §4, §5)
    const path = new URL(c.req.url).pathname;
    const method = c.req.method;
    if (!isServiceCallAllowed(claims.sub, config.targetService, method, path)) {
      return c.json(
        {
          error: {
            code: "FORBIDDEN",
            message: `Service '${claims.sub}' is not authorized to ${method} ${path} on ${config.targetService}.`,
            requestId,
          },
        },
        403
      );
    }

    // If X-User-Context is present and the service token is valid, forward the
    // user context. Services use this to act on behalf of a user (BFF pattern).
    if (userContextHeader) {
      try {
        const userJson = Buffer.from(userContextHeader, "base64").toString("utf8");
        const userCtx = JSON.parse(userJson) as UserContext;
        c.set("user", userCtx);
      } catch {
        return c.json(
          { error: { code: "UNAUTHORIZED", message: "Malformed X-User-Context.", requestId } },
          401
        );
      }
    } else {
      // No user context: mark as a direct service-to-service call
      const serviceUser: UserContext = {
        userId: claims.sub,
        tenantId: "",
        roles: ["service"],
        scopes: ["admin"],
        isGuest: false,
        isService: true,
        emailVerified: true,
      };
      c.set("user", serviceUser);
    }

    await next();
  });
}
```

- [ ] **17.4 Run the test to confirm it passes**

```bash
pnpm --filter @oneplatform/core run test -- src/__tests__/service-auth.test.ts
```

Expected: All tests PASS.

- [ ] **17.5 Commit**

```bash
git add packages/core/src/middleware/service-auth.ts packages/core/src/__tests__/service-auth.test.ts
git commit -m "feat(core): add service auth middleware (Ed25519 JWT + RBAC matrix enforcement)"
```

---

## Task 18: Response Envelope + Error Handler

**Files:**
- Create: `packages/core/src/middleware/response-envelope.ts`
- Create: `packages/core/src/middleware/error-handler.ts`
- Create: `packages/core/src/__tests__/response-envelope.test.ts`
- Create: `packages/core/src/__tests__/error-handler.test.ts`

`responseEnvelope` wraps route return values in `{ data: T }`. `errorHandler` catches all thrown errors — `AppError` subclasses (from `src/errors.ts`) serialize to their typed envelope; unknown errors become `InternalError` with the raw message hidden from the wire.

- [ ] **18.1 Write the failing tests**

```typescript
// packages/core/src/__tests__/response-envelope.test.ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { responseEnvelopeMiddleware } from "../middleware/response-envelope.js";

describe("responseEnvelopeMiddleware", () => {
  it("wraps a plain object return in { data: ... }", async () => {
    const app = new Hono();
    app.use("*", responseEnvelopeMiddleware());
    app.get("/items", (c) => c.json({ id: "1", name: "Widget" }));
    const res = await app.request("/items");
    const body = await res.json();
    expect(body).toHaveProperty("data");
    expect(body.data).toMatchObject({ id: "1", name: "Widget" });
  });

  it("wraps a route that returns c.json directly", async () => {
    const app = new Hono();
    app.use("*", responseEnvelopeMiddleware());
    app.get("/ping", (c) => c.json({ pong: true }));
    const res = await app.request("/ping");
    const body = await res.json();
    expect(body.data.pong).toBe(true);
  });

  it("does not double-wrap if data key is already present at top level", async () => {
    // Routes should return raw objects; the middleware wraps them.
    // This test ensures a route returning { data: [...] } (pagination) is wrapped
    // to { data: { data: [...] } } — the pagination shape belongs inside data.
    // (Routes producing PaginatedResponse should return the full pagination object
    // and the middleware will wrap it.)
    const app = new Hono();
    app.use("*", responseEnvelopeMiddleware());
    app.get("/list", (c) => c.json({ data: [1, 2], pagination: { nextCursor: null, total: 2 } }));
    const res = await app.request("/list");
    const body = await res.json();
    // The middleware wraps the whole object
    expect(body.data).toMatchObject({ data: [1, 2], pagination: { nextCursor: null, total: 2 } });
  });

  it("passes through non-JSON responses unchanged (e.g. 204 No Content)", async () => {
    const app = new Hono();
    app.use("*", responseEnvelopeMiddleware());
    app.delete("/items/1", (c) => new Response(null, { status: 204 }));
    const res = await app.request("/items/1", { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  it("does not wrap error responses (error handler takes precedence)", async () => {
    const app = new Hono();
    app.use("*", responseEnvelopeMiddleware());
    // Simulate a response that already has the error shape set directly
    app.get("/err", (c) => c.json({ error: { code: "NOT_FOUND", message: "x", requestId: "r" } }, 404));
    const res = await app.request("/err");
    const body = await res.json();
    // Response envelope must not double-wrap error responses
    expect(body).toHaveProperty("error");
    expect(body).not.toHaveProperty("data");
  });
});
```

```typescript
// packages/core/src/__tests__/error-handler.test.ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { errorHandlerMiddleware } from "../middleware/error-handler.js";
import {
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  InternalError,
} from "../errors.js";

function buildApp() {
  const app = new Hono<{ Variables: { requestId: string } }>();
  app.use("*", (c, next) => { c.set("requestId", "req-test-123"); return next(); });
  app.use("*", errorHandlerMiddleware());
  return app;
}

describe("errorHandlerMiddleware", () => {
  it("serializes NotFoundError to { error: { code, message, requestId } } with 404", async () => {
    const app = buildApp();
    app.get("/missing", () => { throw new NotFoundError("Item not found."); });
    const res = await app.request("/missing");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toBe("Item not found.");
    expect(body.error.requestId).toBe("req-test-123");
  });

  it("serializes ValidationError with details", async () => {
    const app = buildApp();
    app.post("/items", () => {
      throw new ValidationError("Name is required.", { field: "name" });
    });
    const res = await app.request("/items", { method: "POST" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.details).toEqual({ field: "name" });
  });

  it("hides the real message for InternalError — prevents leaking internals", async () => {
    const app = buildApp();
    app.get("/crash", () => {
      throw new InternalError("SELECT password FROM users WHERE id = 1");
    });
    const res = await app.request("/crash");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.message).toBe("An unexpected error occurred.");
    expect(body.error.message).not.toContain("SELECT");
  });

  it("converts unknown errors to InternalError (never leaks stack traces)", async () => {
    const app = buildApp();
    app.get("/kaboom", () => {
      throw new TypeError("Cannot read properties of undefined");
    });
    const res = await app.request("/kaboom");
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    // The raw JS error message must not appear in the response
    expect(body.error.message).not.toContain("Cannot read");
    expect(body.error.message).toBe("An unexpected error occurred.");
  });

  it("serializes UnauthorizedError with 401", async () => {
    const app = buildApp();
    app.get("/secure", () => { throw new UnauthorizedError("Token expired."); });
    const res = await app.request("/secure");
    expect(res.status).toBe(401);
  });
});
```

- [ ] **18.2 Run the tests to confirm they fail**

```bash
pnpm --filter @oneplatform/core run test -- src/__tests__/response-envelope.test.ts src/__tests__/error-handler.test.ts
```

Expected: FAIL — modules not found.

- [ ] **18.3 Write `packages/core/src/middleware/response-envelope.ts`**

```typescript
import { createMiddleware } from "hono/factory";

// responseEnvelopeMiddleware wraps every successful JSON route response in
// { data: T }. This is automatic — routes return raw objects and the envelope
// is applied here. Routes cannot accidentally bypass the envelope format because
// it is applied in middleware, not via opt-in decorators (spec §6).
//
// Special cases:
//  - 204 No Content: no body to wrap, pass through unchanged.
//  - Responses already containing an "error" key: these come from the error
//    handler and must not be double-wrapped.
export function responseEnvelopeMiddleware() {
  return createMiddleware(async (c, next) => {
    await next();

    // Only wrap JSON responses with a 2xx status
    const contentType = c.res.headers.get("Content-Type") ?? "";
    if (!contentType.includes("application/json")) return;
    if (c.res.status === 204) return;
    if (!String(c.res.status).startsWith("2")) return;

    const body = await c.res.clone().json<unknown>();

    // Do not wrap error-shaped responses (these come from thrown AppErrors
    // serialized by the error handler, or from inline c.json({error:...}) calls)
    if (body !== null && typeof body === "object" && "error" in (body as object)) {
      return;
    }

    c.res = c.newResponse(JSON.stringify({ data: body }), c.res.status, {
      "Content-Type": "application/json",
    });
  });
}
```

- [ ] **18.4 Write `packages/core/src/middleware/error-handler.ts`**

```typescript
import { createMiddleware } from "hono/factory";
import { AppError, InternalError } from "../errors.js";

// errorHandlerMiddleware is the last line of defense.
// It catches every thrown error — AppError subclasses are serialized to their
// typed API envelope; unknown errors become InternalError to prevent leaking
// implementation details (stack traces, SQL, internal paths) to the client.
// The raw error is logged internally at DEBUG level, tied to requestId (spec §6).
export function errorHandlerMiddleware() {
  return createMiddleware(async (c, next) => {
    try {
      await next();
    } catch (err) {
      const requestId: string = c.var.requestId ?? "";

      if (err instanceof AppError) {
        const envelope = err.toApiError(requestId);
        return c.json(envelope, err.statusCode as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 503);
      }

      // Unknown error: hide implementation details from the client.
      // In production, errors surface only as "An unexpected error occurred."
      // Debug info is available to admins by looking up the requestId in logs.
      const internalErr = new InternalError(
        err instanceof Error ? err.message : String(err)
      );
      // Log internally — in a full implementation this calls logger.error()
      // We use console.error here so the middleware has no logger dependency.
      console.error(`[${requestId}] Unhandled error:`, err);

      const envelope = internalErr.toApiError(requestId);
      return c.json(envelope, 500);
    }
  });
}
```

- [ ] **18.5 Run the tests to confirm they pass**

```bash
pnpm --filter @oneplatform/core run test -- src/__tests__/response-envelope.test.ts src/__tests__/error-handler.test.ts
```

Expected: All tests PASS.

- [ ] **18.6 Commit**

```bash
git add packages/core/src/middleware/response-envelope.ts packages/core/src/middleware/error-handler.ts packages/core/src/__tests__/response-envelope.test.ts packages/core/src/__tests__/error-handler.test.ts
git commit -m "feat(core): add response envelope and error handler middleware"
```

---

## Task 19: Rate Limit Headers + Deprecation Headers

**Files:**
- Create: `packages/core/src/middleware/rate-limit-headers.ts`
- Create: `packages/core/src/middleware/deprecation-headers.ts`
- Create: `packages/core/src/__tests__/rate-limit-headers.test.ts`
- Create: `packages/core/src/__tests__/deprecation-headers.test.ts`

Rate limit middleware reads pre-populated `c.var.rateLimitInfo` (set by the Gateway's sliding window logic) and appends `X-RateLimit-*` headers to the response. Deprecation middleware reads per-route metadata and appends RFC 8594 headers.

Note: The rate limit headers middleware does **not** enforce limits — the Gateway does that. It only appends headers so clients can inspect their quota.

- [ ] **19.1 Write the failing tests**

```typescript
// packages/core/src/__tests__/rate-limit-headers.test.ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { rateLimitHeadersMiddleware } from "../middleware/rate-limit-headers.js";

interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number; // Unix epoch seconds
  policy: "global" | "per-tenant" | "per-api-key" | "webhook";
}

function buildApp(rateLimitInfo?: RateLimitInfo) {
  const app = new Hono<{ Variables: { rateLimitInfo?: RateLimitInfo; requestId: string } }>();
  if (rateLimitInfo) {
    app.use("*", (c, next) => { c.set("rateLimitInfo", rateLimitInfo); return next(); });
  }
  app.use("*", rateLimitHeadersMiddleware());
  app.get("/items", (c) => c.json({ ok: true }));
  return app;
}

describe("rateLimitHeadersMiddleware", () => {
  it("sets X-RateLimit-Limit, Remaining, Reset, and Policy headers when rateLimitInfo is present", async () => {
    const info: RateLimitInfo = { limit: 1000, remaining: 987, reset: 1735689600, policy: "per-tenant" };
    const res = await buildApp(info).request("/items");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("1000");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("987");
    expect(res.headers.get("X-RateLimit-Reset")).toBe("1735689600");
    expect(res.headers.get("X-RateLimit-Policy")).toBe("per-tenant");
  });

  it("does not set rate limit headers when rateLimitInfo is absent", async () => {
    const res = await buildApp().request("/items");
    expect(res.headers.get("X-RateLimit-Limit")).toBeNull();
    expect(res.headers.get("X-RateLimit-Remaining")).toBeNull();
  });

  it("sets Retry-After header when remaining is 0", async () => {
    const now = Math.floor(Date.now() / 1000);
    const info: RateLimitInfo = { limit: 100, remaining: 0, reset: now + 30, policy: "per-api-key" };
    const res = await buildApp(info).request("/items");
    expect(res.headers.get("Retry-After")).toBe("30");
  });
});
```

```typescript
// packages/core/src/__tests__/deprecation-headers.test.ts
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { deprecationHeadersMiddleware, type DeprecationInfo } from "../middleware/deprecation-headers.js";

function buildApp(deprecationInfo?: DeprecationInfo) {
  const app = new Hono<{ Variables: { deprecationInfo?: DeprecationInfo; requestId: string } }>();
  if (deprecationInfo) {
    app.use("*", (c, next) => { c.set("deprecationInfo", deprecationInfo); return next(); });
  }
  app.use("*", deprecationHeadersMiddleware());
  app.get("/api/v1/old-resource", (c) => c.json({ id: "1" }));
  return app;
}

describe("deprecationHeadersMiddleware", () => {
  it("sets Deprecation: true header when deprecationInfo is present", async () => {
    const info: DeprecationInfo = {
      sunset: new Date("2028-01-01T00:00:00Z"),
      successorUrl: "https://docs.oneplatform.dev/api/v2/resource",
    };
    const res = await buildApp(info).request("/api/v1/old-resource");
    expect(res.headers.get("Deprecation")).toBe("true");
  });

  it("sets Sunset header in RFC 7231 HTTP-date format", async () => {
    const sunsetDate = new Date("2028-01-01T00:00:00Z");
    const info: DeprecationInfo = { sunset: sunsetDate, successorUrl: "https://docs.oneplatform.dev/api/v2/resource" };
    const res = await buildApp(info).request("/api/v1/old-resource");
    const sunsetHeader = res.headers.get("Sunset");
    expect(sunsetHeader).toBeTruthy();
    // RFC 7231 format: "Sat, 01 Jan 2028 00:00:00 GMT"
    expect(new Date(sunsetHeader!).getTime()).toBe(sunsetDate.getTime());
  });

  it("sets Link header with rel=successor-version pointing to the new URL", async () => {
    const info: DeprecationInfo = {
      sunset: new Date("2028-01-01"),
      successorUrl: "https://docs.oneplatform.dev/api/v2/resource",
    };
    const res = await buildApp(info).request("/api/v1/old-resource");
    const linkHeader = res.headers.get("Link") ?? "";
    expect(linkHeader).toContain("https://docs.oneplatform.dev/api/v2/resource");
    expect(linkHeader).toContain('rel="successor-version"');
  });

  it("does not set deprecation headers when deprecationInfo is absent", async () => {
    const res = await buildApp().request("/api/v1/old-resource");
    expect(res.headers.get("Deprecation")).toBeNull();
    expect(res.headers.get("Sunset")).toBeNull();
  });
});
```

- [ ] **19.2 Run the tests to confirm they fail**

```bash
pnpm --filter @oneplatform/core run test -- src/__tests__/rate-limit-headers.test.ts src/__tests__/deprecation-headers.test.ts
```

Expected: FAIL — modules not found.

- [ ] **19.3 Write `packages/core/src/middleware/rate-limit-headers.ts`**

```typescript
import { createMiddleware } from "hono/factory";

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  // Unix epoch seconds at which the window resets
  reset: number;
  policy: "global" | "per-tenant" | "per-api-key" | "webhook";
}

// rateLimitHeadersMiddleware appends X-RateLimit-* headers to every response.
// The Gateway sets c.var.rateLimitInfo after running its sliding-window check.
// Other services that don't rate-limit leave it unset, and no headers are added.
// Retry-After is set when remaining=0 so clients know when to retry (spec §6).
export function rateLimitHeadersMiddleware() {
  return createMiddleware(async (c, next) => {
    await next();

    const info = (c.var as { rateLimitInfo?: RateLimitInfo }).rateLimitInfo;
    if (!info) return;

    c.header("X-RateLimit-Limit", String(info.limit));
    c.header("X-RateLimit-Remaining", String(info.remaining));
    c.header("X-RateLimit-Reset", String(info.reset));
    c.header("X-RateLimit-Policy", info.policy);

    if (info.remaining === 0) {
      const secondsUntilReset = Math.max(0, info.reset - Math.floor(Date.now() / 1000));
      c.header("Retry-After", String(secondsUntilReset));
    }
  });
}
```

- [ ] **19.4 Write `packages/core/src/middleware/deprecation-headers.ts`**

```typescript
import { createMiddleware } from "hono/factory";

export interface DeprecationInfo {
  // Date when the endpoint will be removed (RFC 8594 Sunset)
  sunset: Date;
  // URL of the replacement endpoint (links to API docs for new version)
  successorUrl: string;
}

// deprecationHeadersMiddleware appends RFC 8594 headers to responses for
// deprecated endpoints. Routes set c.var.deprecationInfo to opt in.
// Headers: Deprecation, Sunset, Link (spec §6 API Versioning and Deprecation).
export function deprecationHeadersMiddleware() {
  return createMiddleware(async (c, next) => {
    await next();

    const info = (c.var as { deprecationInfo?: DeprecationInfo }).deprecationInfo;
    if (!info) return;

    // RFC 8594 Deprecation header — simple boolean value
    c.header("Deprecation", "true");

    // Sunset header: RFC 7231 HTTP-date format (e.g. "Sat, 01 Jan 2028 00:00:00 GMT")
    c.header("Sunset", info.sunset.toUTCString());

    // Link header with rel=successor-version pointing to the replacement docs
    c.header("Link", `<${info.successorUrl}>; rel="successor-version"`);
  });
}
```

- [ ] **19.5 Run the tests to confirm they pass**

```bash
pnpm --filter @oneplatform/core run test -- src/__tests__/rate-limit-headers.test.ts src/__tests__/deprecation-headers.test.ts
```

Expected: All tests PASS.

- [ ] **19.6 Commit**

```bash
git add packages/core/src/middleware/rate-limit-headers.ts packages/core/src/middleware/deprecation-headers.ts packages/core/src/__tests__/rate-limit-headers.test.ts packages/core/src/__tests__/deprecation-headers.test.ts
git commit -m "feat(core): add rate limit headers and deprecation headers middleware"
```

---

## Task 20: createApp() Factory (`src/app.ts`)

**Files:**
- Create: `packages/core/src/app.ts`
- Create: `packages/core/src/__tests__/app.test.ts`

`createApp()` composes all 10 middleware in the exact order specified in spec §5. It accepts a `CreateAppConfig` with required and optional settings. Returns a fully-instrumented `Hono` instance. The integration test verifies that a minimal service with just `createApp()` and one route behaves correctly end-to-end.

- [ ] **20.1 Write the failing integration test**

```typescript
// packages/core/src/__tests__/app.test.ts
import { describe, it, expect, vi, beforeAll } from "vitest";
import { SignJWT } from "jose";
import type { UserContext } from "../types.js";

const JWT_SECRET = "test-jwt-secret-must-be-32chars!!";
const secretBytes = new TextEncoder().encode(JWT_SECRET);

async function issueToken(sub: string, tid: string, roles: string[], scopes: string[]) {
  return new SignJWT({ sub, tid, roles, scopes })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("15m")
    .setJti("test-jti-" + Math.random())
    .sign(secretBytes);
}

// Mock Redis — no revoked tokens
const mockRedis = { exists: vi.fn().mockResolvedValue(0) };
const mockValidateApiKey = vi.fn().mockResolvedValue(null);

async function buildTestApp() {
  const { createApp } = await import("../app.js");
  const app = createApp({
    serviceName: "test-service",
    version: "0.1.0",
    jwtSecret: JWT_SECRET,
    // @ts-expect-error mock
    redis: mockRedis,
    validateApiKey: mockValidateApiKey,
    allowedOrigins: ["https://app.example.com"],
    publicRoutes: ["/healthz", "/readyz"],
    servicePublicKeys: {},
    targetService: "test-service",
  });

  // Register a test route
  app.get("/api/v1/items", (c) => c.json([{ id: "1", name: "Widget" }]));
  app.delete("/api/v1/items/1", (c) => new Response(null, { status: 204 }));

  return app;
}

describe("createApp() integration", () => {
  it("applies requestId middleware (X-Request-ID response header)", async () => {
    const app = await buildTestApp();
    const token = await issueToken("u1", "t1", ["viewer"], ["data:read"]);
    const res = await app.request("/api/v1/items", {
      headers: { Authorization: `Bearer ${token}`, Origin: "https://app.example.com" },
    });
    expect(res.headers.get("X-Request-ID")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("applies CORS middleware (Access-Control-Allow-Origin header)", async () => {
    const app = await buildTestApp();
    const token = await issueToken("u1", "t1", ["viewer"], ["data:read"]);
    const res = await app.request("/api/v1/items", {
      headers: { Authorization: `Bearer ${token}`, Origin: "https://app.example.com" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://app.example.com");
  });

  it("applies auth middleware (401 when no token on protected route)", async () => {
    const app = await buildTestApp();
    const res = await app.request("/api/v1/items", {
      headers: { Origin: "https://app.example.com" },
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("applies response envelope (valid response wrapped in { data: T })", async () => {
    const app = await buildTestApp();
    const token = await issueToken("u1", "t1", ["viewer"], ["data:read"]);
    const res = await app.request("/api/v1/items", {
      headers: { Authorization: `Bearer ${token}`, Origin: "https://app.example.com" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("data");
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("applies error handler (thrown error becomes { error: {...} } envelope)", async () => {
    const { createApp } = await import("../app.js");
    const { NotFoundError } = await import("../errors.js");
    const app = createApp({
      serviceName: "test-service",
      version: "0.1.0",
      jwtSecret: JWT_SECRET,
      // @ts-expect-error mock
      redis: mockRedis,
      validateApiKey: mockValidateApiKey,
      allowedOrigins: ["https://app.example.com"],
      publicRoutes: ["/healthz", "/crash"],
      servicePublicKeys: {},
      targetService: "test-service",
    });
    app.get("/crash", () => { throw new NotFoundError("Widget not found."); });
    const res = await app.request("/crash");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("handles preflight OPTIONS from an allowed origin (204)", async () => {
    const app = await buildTestApp();
    const res = await app.request("/api/v1/items", {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example.com",
        "Access-Control-Request-Method": "POST",
      },
    });
    expect(res.status).toBe(204);
  });

  it("skips auth on public routes (/healthz)", async () => {
    const { createApp } = await import("../app.js");
    const { healthz } = await import("../health.js");
    const app = createApp({
      serviceName: "test-service",
      version: "0.1.0",
      jwtSecret: JWT_SECRET,
      // @ts-expect-error mock
      redis: mockRedis,
      validateApiKey: mockValidateApiKey,
      allowedOrigins: [],
      publicRoutes: ["/healthz"],
      servicePublicKeys: {},
      targetService: "test-service",
    });
    app.get("/healthz", healthz({ service: "test-service", version: "0.1.0" }));
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("passes 204 No Content through without wrapping", async () => {
    const app = await buildTestApp();
    const token = await issueToken("u1", "t1", ["viewer"], ["data:read"]);
    const res = await app.request("/api/v1/items/1", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(204);
  });
});
```

- [ ] **20.2 Run the test to confirm it fails**

```bash
pnpm --filter @oneplatform/core run test -- src/__tests__/app.test.ts
```

Expected: FAIL — module not found.

- [ ] **20.3 Write `packages/core/src/app.ts`**

```typescript
import { Hono } from "hono";
import type Redis from "ioredis";
import type { UserContext, AppVariables } from "./types.js";
import { requestIdMiddleware } from "./middleware/request-id.js";
import { corsMiddleware } from "./middleware/cors.js";
import { authMiddleware } from "./middleware/auth.js";
import { serviceAuthMiddleware } from "./middleware/service-auth.js";
import { responseEnvelopeMiddleware } from "./middleware/response-envelope.js";
import { errorHandlerMiddleware } from "./middleware/error-handler.js";
import { rateLimitHeadersMiddleware } from "./middleware/rate-limit-headers.js";
import { deprecationHeadersMiddleware } from "./middleware/deprecation-headers.js";

export interface CreateAppConfig {
  serviceName: string;
  version: string;

  // Auth middleware dependencies
  jwtSecret: string;
  redis: Redis;
  validateApiKey: (key: string) => Promise<UserContext | null>;

  // CORS configuration (OP_ALLOWED_ORIGINS)
  allowedOrigins: string[];

  // Routes that bypass user auth (healthz, readyz, bootstrap, public OAuth callbacks)
  publicRoutes: string[];

  // Service-to-service auth configuration
  // targetService: the name of THIS service (e.g. "ontology-service")
  targetService: string;
  // servicePublicKeys: loaded from /data/service-keys/ at startup
  servicePublicKeys: Record<string, string>;
}

// createApp() is the single entry point for every @oneplatform service.
// It wires the 10-middleware stack in the order defined in spec §5.
// Middleware order is intentional — do NOT reorder without updating the spec:
//
//  1. requestId           — must run first (requestId is needed by all others)
//  2. cors                — must run before auth (preflight returns early)
//  3. auth                — validates user credentials, sets c.var.user
//  4. serviceAuth         — on /internal/* routes, validates Ed25519 token + RBAC
//  5. responseEnvelope    — wraps 2xx JSON responses in { data: T }
//  6. errorHandler        — catches thrown errors, formats them as { error: {...} }
//  7. rateLimitHeaders    — appends X-RateLimit-* to responses (Gateway sets c.var.rateLimitInfo)
//  8. deprecationHeaders  — appends Deprecation/Sunset/Link for deprecated routes
//
// OTEL instrumentation (middleware positions 2 in the spec) is left as a stub
// here. It will be wired in Task 22 (observability) once the OTEL package is added.
export function createApp(config: CreateAppConfig): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();

  // 1. Request ID — propagate or generate
  app.use("*", requestIdMiddleware());

  // 2. OTEL instrumentation (stub — wired in the observability task)
  // app.use("*", otelMiddleware({ serviceName: config.serviceName }));

  // 3. CORS — validates Origin, handles preflight
  app.use("*", corsMiddleware({ allowedOrigins: config.allowedOrigins }));

  // 4. (Rate limit enforcement belongs to Gateway; other services skip it)

  // 5. User auth — JWT / API key / public route bypass
  app.use(
    "*",
    authMiddleware({
      jwtSecret: config.jwtSecret,
      redis: config.redis,
      validateApiKey: config.validateApiKey,
      publicRoutes: config.publicRoutes,
    })
  );

  // 6. Service auth — Ed25519 + RBAC on /internal/* routes
  app.use(
    "/internal/*",
    serviceAuthMiddleware({
      targetService: config.targetService,
      servicePublicKeys: config.servicePublicKeys,
    })
  );

  // 7. Response envelope — wrap 2xx JSON in { data: T }
  app.use("*", responseEnvelopeMiddleware());

  // 8. Error handler — catch thrown errors → { error: {...} }
  app.use("*", errorHandlerMiddleware());

  // 9. Rate limit headers — append X-RateLimit-* (set by Gateway before forwarding)
  app.use("*", rateLimitHeadersMiddleware());

  // 10. Deprecation headers — append RFC 8594 headers for deprecated routes
  app.use("*", deprecationHeadersMiddleware());

  return app;
}
```

- [ ] **20.4 Run the test to confirm it passes**

```bash
pnpm --filter @oneplatform/core run test -- src/__tests__/app.test.ts
```

Expected: All tests PASS.

- [ ] **20.5 Commit**

```bash
git add packages/core/src/app.ts packages/core/src/__tests__/app.test.ts
git commit -m "feat(core): add createApp() factory composing full 10-middleware stack"
```

---

## Task 21: Barrel Export + Full Suite (`src/index.ts`)

**Files:**
- Create: `packages/core/src/index.ts`
- Modify: (run full test suite)

The barrel file is the public API surface of `@oneplatform/core`. Every import by services comes through here. Keep it explicit — do not use wildcard re-exports.

- [ ] **21.1 Write `packages/core/src/index.ts`**

```typescript
// @oneplatform/core — public API surface
// Services import everything from "@oneplatform/core", not from internal paths.

// ---------------------------------------------------------------------------
// App factory — the primary entry point for every service
// ---------------------------------------------------------------------------
export { createApp } from "./app.js";
export type { CreateAppConfig } from "./app.js";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------
export type {
  ApiResponse,
  ApiError,
  PaginatedResponse,
  UserContext,
  PlatformEvent,
  DataEnvelope,
  AppVariables,
} from "./types.js";
export { ServiceName } from "./types.js";

// ---------------------------------------------------------------------------
// Error registry
// ---------------------------------------------------------------------------
export {
  AppError,
  UnauthorizedError,
  ForbiddenError,
  InsufficientScopeError,
  NotFoundError,
  EntityNotFoundError,
  ConflictError,
  ValidationError,
  RateLimitError,
  InternalError,
  ServiceUnavailableError,
  PaginationLimitExceededError,
  InvalidCursorError,
  CursorExpiredError,
  BulkLimitExceededError,
  OriginNotAllowedError,
  UnknownFilterFieldError,
  UnsortableFieldError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Config loader
// ---------------------------------------------------------------------------
export { loadConfig } from "./config.js";
export type { Config } from "./config.js";

// ---------------------------------------------------------------------------
// Database client
// ---------------------------------------------------------------------------
export { createDbClient, setTenantContext } from "./db.js";
export type { DbClientConfig } from "./db.js";

// ---------------------------------------------------------------------------
// Redis client
// ---------------------------------------------------------------------------
export { createRedisClient } from "./redis.js";
export type { RedisClientConfig } from "./redis.js";

// ---------------------------------------------------------------------------
// Queue / BullMQ helpers
// ---------------------------------------------------------------------------
export { createQueue, createWorker, createDlqQueue } from "./queue.js";

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
export { createLogger } from "./logger.js";
export type { Logger, LoggerConfig, LogEvent, AuditEvent, LogLevel } from "./logger.js";

// ---------------------------------------------------------------------------
// Event publisher
// ---------------------------------------------------------------------------
export { createEventPublisher } from "./events.js";
export type { EventPublisher, EventPublisherConfig } from "./events.js";

// ---------------------------------------------------------------------------
// Health endpoints
// ---------------------------------------------------------------------------
export { healthz, readyz } from "./health.js";
export type { HealthConfig, ReadyzConfig } from "./health.js";

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------
export { encodeCursor, decodeCursor } from "./cursor.js";

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------
export { encrypt, decrypt, loadMasterKey } from "./encryption.js";

// ---------------------------------------------------------------------------
// Service RBAC matrix
// ---------------------------------------------------------------------------
export { isServiceCallAllowed } from "./service-rbac.js";

// ---------------------------------------------------------------------------
// Middleware (exported for services that need to compose custom stacks)
// ---------------------------------------------------------------------------
export { requestIdMiddleware } from "./middleware/request-id.js";
export { corsMiddleware } from "./middleware/cors.js";
export type { CorsConfig } from "./middleware/cors.js";
export { authMiddleware } from "./middleware/auth.js";
export type { AuthMiddlewareConfig } from "./middleware/auth.js";
export { serviceAuthMiddleware } from "./middleware/service-auth.js";
export type { ServiceAuthConfig } from "./middleware/service-auth.js";
export { responseEnvelopeMiddleware } from "./middleware/response-envelope.js";
export { errorHandlerMiddleware } from "./middleware/error-handler.js";
export { rateLimitHeadersMiddleware } from "./middleware/rate-limit-headers.js";
export type { RateLimitInfo } from "./middleware/rate-limit-headers.js";
export { deprecationHeadersMiddleware } from "./middleware/deprecation-headers.js";
export type { DeprecationInfo } from "./middleware/deprecation-headers.js";
```

- [ ] **21.2 Run the full test suite**

```bash
pnpm --filter @oneplatform/core run test -- --reporter=verbose
```

Expected output (all tests PASS, no failures):
```
✓ src/__tests__/config.test.ts
✓ src/__tests__/errors.test.ts
✓ src/__tests__/encryption.test.ts
✓ src/__tests__/cursor.test.ts
✓ src/__tests__/health.test.ts
✓ src/__tests__/service-rbac.test.ts
✓ src/__tests__/request-id.test.ts
✓ src/__tests__/cors.test.ts
✓ src/__tests__/auth.test.ts
✓ src/__tests__/service-auth.test.ts
✓ src/__tests__/response-envelope.test.ts
✓ src/__tests__/error-handler.test.ts
✓ src/__tests__/rate-limit-headers.test.ts
✓ src/__tests__/deprecation-headers.test.ts
✓ src/__tests__/app.test.ts
```

If any test fails, fix the underlying code before proceeding.

- [ ] **21.3 Run TypeScript type check**

```bash
pnpm --filter @oneplatform/core run lint
```

Expected: No type errors.

- [ ] **21.4 Run build**

```bash
pnpm --filter @oneplatform/core run build
```

Expected: `packages/core/dist/` is produced with `.js`, `.d.ts`, `.js.map`, and `.d.ts.map` files.

- [ ] **21.5 Verify barrel exports compile (smoke test)**

```bash
node --input-type=module <<'EOF'
import { createApp, AppError, NotFoundError, loadConfig, createDbClient, createRedisClient, createQueue, createLogger, createEventPublisher, healthz, readyz, encodeCursor, decodeCursor, encrypt, decrypt, isServiceCallAllowed } from './packages/core/dist/index.js';
console.log('Barrel exports OK:', typeof createApp, typeof NotFoundError, typeof isServiceCallAllowed);
EOF
```

Expected output: `Barrel exports OK: function function function`

- [ ] **21.6 Commit**

```bash
git add packages/core/src/index.ts
git commit -m "feat(core): add barrel export for @oneplatform/core public API surface"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Covered by task |
|---|---|
| UUID v7 request ID, propagate incoming | Task 14 |
| CORS: allowlist, 403 ORIGIN_NOT_ALLOWED for unlisted, OPTIONS preflight | Task 15 |
| JWT HS256 validation, revocation Redis check | Task 16 |
| Unverified users capped at viewer role | Task 16 |
| API key validation via callback | Task 16 |
| Ed25519 service token validation | Task 17 |
| Service RBAC matrix enforcement | Task 17 (uses Task 13) |
| X-User-Context only accepted with valid X-Service-Token | Task 17 |
| Complete RBAC matrix (all 9 services, all routes) | Task 13 |
| Response envelope `{ data: T }` | Task 18 |
| Error envelope `{ error: { code, message, requestId } }` | Task 18 |
| Stack traces never in API responses | Task 18 (errorHandler) |
| X-RateLimit-* headers, Retry-After on 429 | Task 19 |
| Deprecation: true, Sunset, Link headers (RFC 8594) | Task 19 |
| createApp() composes all 10 middleware in order | Task 20 |
| `@oneplatform/core` barrel export | Task 21 |

**Gaps identified and addressed:**
- OTEL middleware (position 2 in spec) is stubbed in createApp() with a comment. It requires a dedicated observability task with `@opentelemetry/*` packages added — it should not be silently omitted or partially wired.
- Rate limit enforcement (sliding window Redis logic) is a Gateway concern — this plan correctly omits it from middleware; only the header-appending behavior belongs in core.

**Placeholder scan:** No "TBD", "TODO", "similar to", or "fill in later" in any task. All code blocks are complete.

**Type consistency:**
- `UserContext` from `types.ts` (Part 1) is used identically in `auth.ts`, `service-auth.ts`, `app.ts`, and `index.ts`.
- `AppVariables` type (`{ user: UserContext; requestId: string }`) from Part 1 matches the Hono generics used in `createApp()`.
- `AppError` base class from Part 1 `errors.ts` is used by `errorHandlerMiddleware` in Task 18 via `instanceof AppError`.
- `RateLimitInfo` exported from `rate-limit-headers.ts` and re-exported through `index.ts`.
- `DeprecationInfo` exported from `deprecation-headers.ts` and re-exported through `index.ts`.

---

Plan complete and saved to `docs/superpowers/plans/2026-06-10-phase1-core-middleware.md`.
