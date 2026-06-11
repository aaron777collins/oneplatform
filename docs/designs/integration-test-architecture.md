# Integration and End-to-End Test Architecture

**Version:** 2.0 (revised — resolves blockers B1-B5 from review)
**Status:** Approved for implementation
**Date:** 2026-06-11

---

## 1. Overview

This document defines the complete test architecture for OnePlatform integration and end-to-end tests. It supersedes any earlier drafts and is the authoritative reference a developer should follow to implement the test infrastructure.

### 1.1 Scope

This document covers three test levels:

- **Level 1 — In-process HTTP:** The Hono app is loaded in the test process via a `createApp()` factory, calling `app.fetch()` directly. Real PostgreSQL and Redis on test ports. No network server started.
- **Level 2 — Out-of-process single service:** The service is spawned as a real Node process. HTTP requests go over `localhost`. Tests target one service at a time.
- **Level 3 — Full stack E2E:** All services are started. Tests exercise multi-service flows across the full request path.

The architecture does **not** cover unit tests (those already exist in each service's `__tests__/` directory using mocked dependencies) or load/performance tests.

### 1.2 What is NOT in scope

- PgBouncer. Tests connect to PostgreSQL directly. PgBouncer is a production concern.
- MinIO in Level 1. Plugin bundle and app artifact tests at Level 2/3 bring up a MinIO container.
- The execution service's Docker sandbox proxy. That path is tested at Level 3 only.

---

## 2. Blocker Resolutions

### B1 — Services don't export the Hono app (resolved by `createApp()` factory refactor)

Every service `index.ts` currently follows the pattern:

```typescript
async function main(): Promise<void> {
  const config = loadConfig();
  const db = createDbClient({ ... });
  // ... build all deps ...
  const app = createApp({ ... });  // local variable, not exported
  // ... register routes ...
  server.listen(port, ...);
}
main().catch(...)
```

The Hono `app` is local to `main()`. There is no export. `app.fetch()` is unreachable from tests.

**Resolution:** Each service `index.ts` is refactored to export a `createServiceApp()` factory that builds the full wired application and returns it alongside a cleanup handle. The existing `main()` becomes a thin wrapper that calls the factory and starts the HTTP server.

Section 3 specifies the exact factory contract.

### B2 — TEST_* env vars don't work with loadConfig() (resolved by using OP_* vars directly)

`loadConfig()` reads `process.env` and parses keys with the `OP_` prefix via Zod. There is no alias or remapping layer. `TEST_*` vars are invisible to it.

**Resolution:** Tests set `OP_*` variables directly in `process.env` before importing the service factory. Level 2/3 globalSetup passes `OP_*` vars in the `env` option of `child_process.spawn`. A committed `.env.test` file contains the values for the test infrastructure. No `TEST_*` prefix is used anywhere in test code.

### B3 — Level 2 port assignments need explicit PORT overrides (resolved by documented per-service PORT mapping)

When Level 2 spawns a service process, the process reads `process.env["PORT"] ?? "<default>"`. Without an explicit override, multiple spawned services could share a port or use a port that conflicts with a developer's running stack.

**Resolution:** The globalSetup for Level 2 and Level 3 explicitly passes `PORT=<test-port>` in the spawn env for every service. Section 5.2 documents the test port map.

### B4 — Transaction rollback can't isolate cross-connection writes (resolved by per-test tenant UUID + RLS)

Per-test transaction rollback only isolates the test's own connection. Service code uses separate pool connections that the test does not own. Rolling back the test connection leaves service-written rows intact.

**Resolution:** Level 1 tests use per-test unique tenant UUIDs. Because every multi-tenant table (auth, ingestion, pipeline, app) enforces RLS via `current_setting('app.tenant_id')`, each test's data is invisible to other tests as long as tenant UUIDs are distinct. Tests clean up their tenant rows in `afterAll`, not via rollback. This is fast: `DELETE FROM <schema>.<table> WHERE tenant_id = $1` on small datasets is sub-millisecond.

Services that do not use RLS on some tables (ontology, plugin — see Section 6.1 for per-service details) use a different isolation strategy: unique slug or name prefixes that are cleaned up in `afterAll`.

### B5 — runMigrations() path resolution depends on compiled vs source (resolved by requiring build before tests)

`runMigrations()` computes `MIGRATIONS_DIR` via `import.meta.url` pointing to the compiled `.js` file in `dist/`. When the test imports the TypeScript source directly, `import.meta.url` resolves to the `src/` path, and the migrations directory is not found.

**Resolution:** Integration tests import from the compiled `dist/` directory, not from `src/`. `turbo run build` must be run before running Level 1 integration tests. This is already standard for the monorepo: the `turbo.json` `test` task has `"dependsOn": ["^build"]`, so `pnpm test` in the root already enforces it. For developers running tests manually in a single service directory, the README must state: run `pnpm build` first.

---

## 3. The createServiceApp() Factory Contract

Every service must export a `createServiceApp()` function. This is a **mechanical refactor** of the existing `main()` function: extract the wiring logic into a named export, keep `main()` as the entry point that calls it.

### 3.1 Return type

```typescript
export interface ServiceApp {
  // The fully wired Hono application. Use app.fetch() in Level 1 tests.
  app: Hono<{ Variables: AppVariables }>;

  // Releases all held resources: closes DB pool, disconnects Redis,
  // stops BullMQ workers, stops background schedulers.
  // Must be called in afterAll to prevent test process hangs.
  cleanup: () => Promise<void>;
}
```

### 3.2 Config type per service

Each service defines its own config type based on what `main()` already reads. The config type must cover every env var read during wiring. All fields should have sensible test defaults.

Example for auth service:

```typescript
export interface AuthServiceConfig {
  databaseUrl: string;
  redisUrl: string;
  jwtSecret: string;
  masterKey: string;          // base64-encoded 32 bytes
  allowedOrigins: string[];
  bootstrapTokenPath?: string; // defaults to /data/init/bootstrap.token
  serviceKeysDir?: string;     // defaults to /data/service-keys (returns {} on ENOENT)
  port?: number;               // only used when main() starts the server
}
```

### 3.3 Factory function signature

```typescript
export async function createServiceApp(
  config: AuthServiceConfig
): Promise<ServiceApp>
```

The factory:
1. Calls `loadConfig()` by ensuring the relevant `OP_*` vars are set in `process.env` **before** the call, or accepts pre-parsed config values and constructs the Hono app directly (bypassing `loadConfig()` for test flexibility).
2. Creates real DB pool and Redis client pointing at test infrastructure.
3. Runs `runMigrations()` (idempotent — safe to call multiple times).
4. Builds all repositories and services.
5. Creates and returns the Hono app with the full middleware stack.
6. Returns a `cleanup` function that terminates the pool and Redis connection.

### 3.4 The revised main() entry point

```typescript
async function main(): Promise<void> {
  // Set env vars from process.env, then delegate to factory.
  const { app, cleanup } = await createServiceApp({
    databaseUrl:    process.env["OP_DATABASE_URL"] ?? "",
    redisUrl:       process.env["OP_REDIS_URL"] ?? "",
    jwtSecret:      process.env["OP_JWT_SECRET"] ?? "",
    masterKey:      process.env["OP_MASTER_KEY"] ?? "",
    allowedOrigins: (process.env["OP_ALLOWED_ORIGINS"] ?? "http://localhost:3000")
                      .split(",").map(s => s.trim()),
    serviceKeysDir: process.env["OP_SERVICE_KEYS_DIR"],
  });

  const port = parseInt(process.env["PORT"] ?? "3001", 10);
  const server = createServer(nodeHttpAdapter(app));

  server.listen(port, () => {
    console.info(`Auth service started on port ${port}`);
  });

  process.on("SIGTERM", async () => {
    server.close();
    await cleanup();
    process.exit(0);
  });
}

main().catch((err: unknown) => {
  console.error("Auth service failed to start:", err);
  process.exit(1);
});
```

The `nodeHttpAdapter` is the existing Node HTTP bridge code that already appears in every service (the `createServer` + `IncomingMessage` bridge block). This should be extracted into `@oneplatform/core` as `createNodeAdapter(app)` in a follow-up task. Until then, each service keeps its inline bridge.

### 3.5 Service-specific factory notes

**Auth service** has additional complexity: the bootstrap token file and the in-memory token lifecycle. The factory accepts optional `bootstrapToken?: string | null` so tests can inject a token directly without touching the filesystem.

**Ontology service** has `cleanupService.startBackgroundJob()`. The factory should accept `startBackgroundJobs?: boolean` (defaults `true`) so tests can skip the background job to avoid timer leaks.

**Plugin service** has the MinIO ping in startup. The factory accepts `skipMinioVerification?: boolean` (defaults `false`). Level 1 tests pass `true` and will fail at the route level if a test actually exercises bundle storage — that is correct behavior.

**Pipeline service** verifies advisory lock capability on startup. This works fine in Level 1 since the test pool connects to real PostgreSQL. No special handling needed.

**Ingestion service** spawns BullMQ workers. Level 1 tests pass `startWorkers: false` to the factory. Worker behavior is tested at Level 2.

**App service** spawns a BullMQ retention worker and queue scheduler. Same pattern: `startWorkers: false` for Level 1.

---

## 4. Test Infrastructure

### 4.1 Prerequisites

| Dependency | Version | Purpose |
|---|---|---|
| PostgreSQL | 16 | Persistent storage for all services |
| Redis | 7 | Queues, cache, pub/sub, auth state |
| Vitest | 1.x | Test runner (already in use) |
| testcontainers (optional) | latest | Manages Docker containers per test run |

For CI, a `docker-compose.test.yml` starts PostgreSQL and Redis on dedicated test ports before the test suite runs. For local development, developers can point tests at an already-running local stack.

### 4.2 Test PostgreSQL setup

A single PostgreSQL instance is used for all test levels. Each service migrates its own schema on first run. Tests are isolated via tenant UUID (see Section 7), not via separate databases.

```sql
-- No special test database is required.
-- Each service creates its own schema (auth, ontology, ingestion, plugin, pipeline, app).
-- The test user must have CREATE SCHEMA rights.
```

The test PostgreSQL user must be a superuser or have `SET SESSION AUTHORIZATION` capability, because the `bypass_rls` GUC is set during tests that need to read across tenants (admin views). In practice, a dedicated `op_test` user with `SUPERUSER` is simplest for test infrastructure.

### 4.3 Test Redis setup

A single Redis instance on a test port. No Redis password required in test environment (keeps `.env.test` simple). Redis logical databases are not required for tests — services use the default DB 0.

### 4.4 .env.test file

This file is committed to the repository at the monorepo root. It contains test-only values. It is **not** `.gitignore`d — the values are not secrets (they're test credentials for a local Docker container).

```dotenv
# .env.test
# Used by Level 1 integration tests and Level 2/3 globalSetup.
# These values point at containers started by docker-compose.test.yml.

# Infrastructure
OP_DATABASE_URL=postgresql://op_test:op_test@localhost:5433/op_test
OP_REDIS_URL=redis://localhost:6380

# Security — test-only values, not real secrets
# OP_MASTER_KEY: 32 bytes = 256 bits, base64-encoded.
# Generated with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
# This specific value is committed only for test use.
OP_MASTER_KEY=dGVzdG1hc3Rlcmtlc3RrZXkxMjM0NTY3ODkwYWJjZA==
OP_JWT_SECRET=test-jwt-secret-for-integration-tests-32c
OP_CURSOR_SECRET=test-cursor-secret-for-integration-32c

# Service identity
OP_BASE_URL=http://localhost:3000
OP_ALLOWED_ORIGINS=http://localhost:3000
OP_REQUIRE_EMAIL_VERIFICATION=false
OP_WEBHOOK_ALLOW_HTTP=true

# Service token (for service-to-service internal calls in Level 2/3)
OP_SERVICE_TOKEN_SECRET=test-service-token-secret-not-real

# Sensible defaults for optional configs
OP_GLOBAL_RATE_LIMIT=10000
OP_SANDBOX_POOL_SIZE=1
OP_CONNECTOR_TIMEOUT_SECONDS=10
OP_INGESTION_BATCH_SIZE=100
OP_LARGE_SYNC_CONCURRENCY=1
OP_MIGRATION_TIMEOUT=60
OP_ONTOLOGY_POLL_INTERVAL=1
```

**Note on OP_MASTER_KEY format:** The value must decode to exactly 32 bytes. The example above is a placeholder — generate a real test value with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` and commit it to `.env.test`. Since this is a test-only value with no real data encrypted, committing it is safe.

### 4.5 docker-compose.test.yml

```yaml
# docker/docker-compose.test.yml
# Starts test infrastructure on non-default ports to avoid conflicts.
services:
  postgres-test:
    image: postgres:16
    environment:
      POSTGRES_USER: op_test
      POSTGRES_PASSWORD: op_test
      POSTGRES_DB: op_test
    ports:
      - "5433:5432"
    tmpfs:
      - /var/lib/postgresql/data   # in-memory for speed, data not persisted

  redis-test:
    image: redis:7
    ports:
      - "6380:6379"
    tmpfs:
      - /data
```

Start with: `docker compose -f docker/docker-compose.test.yml up -d`
Stop with: `docker compose -f docker/docker-compose.test.yml down`

---

## 5. Test Organization

### 5.1 Directory structure

```
services/
  auth/
    src/
      __tests__/           # unit tests (existing — not changed)
    integration/
      level1/
        bootstrap.test.ts
        login-flow.test.ts
        api-keys.test.ts
        rbac.test.ts
      level2/
        globalSetup.ts
        auth-service.test.ts
      helpers/
        test-app.ts        # creates a Level 1 app instance
        tenant.ts          # per-test tenant UUID helpers
        fixtures.ts        # shared data builders

  ontology/
    integration/
      level1/
        entity-crud.test.ts
        mapping.test.ts
        migration-status.test.ts
      level2/
        globalSetup.ts
        ontology-service.test.ts
      helpers/
        test-app.ts
        tenant.ts
        fixtures.ts

  # ... same structure for ingestion, plugin, pipeline, app

tests/
  level3/
    globalSetup.ts         # starts all services
    globalTeardown.ts
    auth-to-ontology.test.ts
    ingestion-pipeline.test.ts
    full-stack-app-deploy.test.ts
  helpers/
    service-clients.ts     # typed HTTP clients for each service
    wait-for-ready.ts      # polls /healthz until 200
    tenant.ts
```

### 5.2 Test port map (Level 2 and Level 3)

| Service | Default port | Test port (Level 2) | Test port (Level 3) |
|---|---|---|---|
| Auth | 3001 | 13001 | 13001 |
| Ingestion | 3002 | 13002 | 13002 |
| Ontology | 3003 | 13003 | 13003 |
| Pipeline | 3004 | 13004 | 13004 |
| Execution | 3005 | 13005 | 13005 |
| App | 3006 | 13006 | 13006 |
| Logging | 3007 | 13007 | 13007 |
| Plugin | 3008 | 13008 | 13008 |
| Gateway | 3000 | 13000 | 13000 |

Test ports are in the 13000 range to make them memorable and to avoid conflicts with common development ports.

### 5.3 Vitest configuration per level

Each level has a dedicated vitest config file:

```typescript
// services/auth/vitest.integration.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["integration/level1/**/*.test.ts"],
    globalSetup: ["integration/helpers/global-setup.ts"],
    environment: "node",
    testTimeout: 30_000,
    pool: "forks",       // separate process per test file to avoid env pollution
    poolOptions: {
      forks: { singleFork: false },
    },
    // Load .env.test before any test file is imported
    env: Object.fromEntries(
      Object.entries(
        await import("dotenv").then(d => d.config({ path: "../../.env.test" }).parsed ?? {})
      )
    ),
  },
});
```

The `pool: "forks"` setting is important: each test file runs in a fork, preventing `process.env` mutations from one test file leaking into another.

```typescript
// tests/level3/vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["level3/**/*.test.ts"],
    globalSetup: ["level3/globalSetup.ts"],
    globalTeardown: ["level3/globalTeardown.ts"],
    environment: "node",
    testTimeout: 60_000,    // E2E tests can be slow
    pool: "forks",
    sequence: {
      sequential: true,     // Level 3 tests run sequentially to avoid port contention
    },
  },
});
```

---

## 6. RLS and Isolation Strategy

### 6.1 Per-service RLS status

This table reflects the actual schema in each service's `001_initial_schema.sql`:

| Service | Schema | RLS enforced | Isolation method |
|---|---|---|---|
| Auth | `auth` | Yes — `users`, `roles`, `api_keys`, `oauth_clients` have `ENABLE ROW LEVEL SECURITY` with `users_tenant_isolation` policy using `current_setting('app.tenant_id')` and `bypass_rls` GUC | Per-test tenant UUID |
| Ingestion | `ingestion` | Yes — `connectors`, `webhook_receivers`, `upload_jobs` have RLS policies | Per-test tenant UUID |
| Pipeline | `pipeline` | Yes — `pipelines`, `runs`, `run_steps` have RLS policies with `bypass_rls` GUC | Per-test tenant UUID |
| Ontology | `ontology` | No RLS policies in schema. Tables have `tenant_id` column but no `ENABLE ROW LEVEL SECURITY` statement. | Per-test unique tenant UUID prefix on slug/name fields + DELETE cleanup in afterAll |
| Plugin | `plugin` | No RLS policies in schema. `instances` and `hooks` tables have `tenant_id` column only. | Per-test unique tenant UUID + DELETE cleanup in afterAll |
| App | `app` | No RLS policies in schema. `apps` table has `tenant_id` column only. | Per-test unique tenant UUID + DELETE cleanup in afterAll |

**Important:** For services without RLS (ontology, plugin, app), tests must still use unique tenant UUIDs per test. Without RLS, there is no automatic filtering — the tenant UUID is used only to distinguish which rows belong to which test for cleanup purposes. Tests in these services must be written such that they query or assert only on rows with their own `tenant_id`, not on row counts that would be affected by other concurrent tests.

### 6.2 The `bypass_rls` GUC

Services that have RLS define a `bypass_rls` GUC (`current_setting('app.bypass_rls', true) = 'true'`) in some policies. This allows service-level admin operations to cross tenant boundaries. In tests, this GUC is never set — tests always operate within a single tenant context. The test user is a superuser (which also bypasses RLS at the PostgreSQL level), so direct cleanup queries (`DELETE FROM auth.users WHERE tenant_id = $1`) do not need the GUC.

### 6.3 Per-test tenant UUID pattern

```typescript
// services/auth/integration/helpers/tenant.ts

import { randomUUID } from "node:crypto";
import type pg from "pg";

/**
 * Creates a new unique tenant UUID for a test.
 * Each test case must call this once and pass the returned tenantId
 * to all API calls and fixture builders.
 */
export function newTenantId(): string {
  return randomUUID();
}

/**
 * Deletes all rows created by a test in the auth schema.
 * Call in afterAll with the test's tenantId.
 * Uses SUPERUSER connection — bypasses RLS for direct cleanup.
 */
export async function cleanupAuthTenant(pool: pg.Pool, tenantId: string): Promise<void> {
  // Delete in dependency order (foreign key constraints)
  await pool.query("DELETE FROM auth.entity_permissions WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM auth.api_keys WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM auth.oauth_clients WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM auth.roles WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM auth.users WHERE tenant_id = $1", [tenantId]);
}
```

The pool passed to cleanup functions is the service's pool (connected via `OP_DATABASE_URL`). Since the test PostgreSQL user is a superuser, these deletes bypass RLS and succeed regardless of the session GUC state.

---

## 7. Level 1 Test Pattern

Level 1 tests import the service's `createServiceApp()` factory, create a real DB + Redis connection, and call `app.fetch()` directly.

### 7.1 Test app setup

```typescript
// services/auth/integration/helpers/test-app.ts

import { createDbClient, createRedisClient } from "@oneplatform/core";
// Import from compiled dist/ — required for runMigrations() path resolution (B5)
import { createServiceApp } from "../../dist/index.js";

let sharedDb: ReturnType<typeof createDbClient> | null = null;
let sharedRedis: ReturnType<typeof createRedisClient> | null = null;

/**
 * Creates a Level 1 test instance of the auth service.
 * Migrations are run once on first call (idempotent).
 * Returns app + cleanup.
 */
export async function buildTestApp() {
  const db = createDbClient({
    connectionString: process.env["OP_DATABASE_URL"]!,
    maxConnections: 5,
  });

  const { app, cleanup } = await createServiceApp({
    databaseUrl:    process.env["OP_DATABASE_URL"]!,
    redisUrl:       process.env["OP_REDIS_URL"]!,
    jwtSecret:      process.env["OP_JWT_SECRET"]!,
    masterKey:      process.env["OP_MASTER_KEY"]!,
    allowedOrigins: ["http://localhost:3000"],
    // Skip filesystem reads in tests
    bootstrapToken:          null,
    serviceKeysDir:          undefined,  // returns {} silently
    startBackgroundJobs:     false,
    startWorkers:            false,
    skipMinioVerification:   true,
  });

  return { app, cleanup, db };
}
```

### 7.2 Example Level 1 test

```typescript
// services/auth/integration/level1/login-flow.test.ts

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildTestApp } from "../helpers/test-app.js";
import { newTenantId, cleanupAuthTenant } from "../helpers/tenant.js";
import type pg from "pg";
import { createDbClient } from "@oneplatform/core";

describe("Auth service — login flow", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>["app"];
  let cleanup: () => Promise<void>;
  let db: pg.Pool;

  beforeAll(async () => {
    const result = await buildTestApp();
    app    = result.app;
    cleanup = result.cleanup;
    db     = result.db;
  });

  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  it("registers a user and issues tokens", async () => {
    const tenantId = newTenantId();

    try {
      const res = await app.fetch(
        new Request("http://localhost/api/v1/auth/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: `user-${tenantId}@example.com`,
            password: "Correct-Horse-Battery-Staple-99",
            tenantName: `test-tenant-${tenantId}`,
          }),
        })
      );

      expect(res.status).toBe(201);
      const body = await res.json() as { data: { accessToken: string; refreshToken: string } };
      expect(body.data.accessToken).toBeTruthy();
      expect(body.data.refreshToken).toBeTruthy();
    } finally {
      await cleanupAuthTenant(db, tenantId);
    }
  });

  it("returns 401 for wrong password", async () => {
    const tenantId = newTenantId();

    // Register first
    await app.fetch(
      new Request("http://localhost/api/v1/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: `user-${tenantId}@example.com`,
          password: "Correct-Horse-Battery-Staple-99",
          tenantName: `test-tenant-${tenantId}`,
        }),
      })
    );

    try {
      const res = await app.fetch(
        new Request("http://localhost/api/v1/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: `user-${tenantId}@example.com`,
            password: "wrong-password",
          }),
        })
      );

      expect(res.status).toBe(401);
    } finally {
      await cleanupAuthTenant(db, tenantId);
    }
  });
});
```

### 7.3 Why try/finally for cleanup

Cleanup goes in a `try/finally` block inside each test, not only in `afterAll`. This ensures the test's tenant rows are deleted even when the test assertion fails. `afterAll` cleanup is a second safety net for rows that survived the `finally` block (e.g., rows written by the service in a background job before `startBackgroundJobs: false` took effect).

---

## 8. Level 2 Test Pattern

Level 2 tests spawn a real service process and talk to it over HTTP. This validates the Node HTTP adapter, port binding, startup sequence, and SIGTERM handling.

### 8.1 globalSetup.ts (auth service example)

```typescript
// services/auth/integration/level2/globalSetup.ts

import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

let proc: ChildProcess | null = null;

export async function setup(): Promise<void> {
  // Require build artifact (B5)
  const entryPoint = resolve(
    import.meta.dirname,
    "../../dist/index.js"
  );

  proc = spawn("node", [entryPoint], {
    env: {
      // Pass all OP_* vars from .env.test (already loaded by dotenv in vitest config)
      ...process.env,
      // B3: explicit PORT to avoid conflict with other services
      PORT: "13001",
      // Override URLs to point at test infrastructure
      OP_DATABASE_URL: process.env["OP_DATABASE_URL"]!,
      OP_REDIS_URL:    process.env["OP_REDIS_URL"]!,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout?.on("data", (d: Buffer) => process.stdout.write(`[auth-l2] ${d}`));
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[auth-l2] ${d}`));

  // Wait for the service to be ready
  await waitForHealthy("http://localhost:13001/healthz", 30_000);
}

export async function teardown(): Promise<void> {
  if (proc !== null) {
    proc.kill("SIGTERM");
    await new Promise<void>((resolve) => proc!.on("close", resolve));
  }
}

async function waitForHealthy(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch {
      // Not ready yet
    }
    await new Promise<void>((r) => setTimeout(r, 200));
  }
  throw new Error(`Service at ${url} did not become healthy within ${timeoutMs}ms`);
}
```

### 8.2 Level 2 test example

```typescript
// services/auth/integration/level2/auth-service.test.ts

import { describe, it, expect } from "vitest";
import { newTenantId } from "../helpers/tenant.js";
import { createDbClient } from "@oneplatform/core";

const BASE = "http://localhost:13001";
const db = createDbClient({
  connectionString: process.env["OP_DATABASE_URL"]!,
  maxConnections: 2,
});

describe("Auth service — Level 2 HTTP", () => {
  it("GET /healthz returns 200", async () => {
    const res = await fetch(`${BASE}/healthz`);
    expect(res.status).toBe(200);
  });

  it("POST /api/v1/auth/register returns 201", async () => {
    const tenantId = newTenantId();
    try {
      const res = await fetch(`${BASE}/api/v1/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: `user-${tenantId}@example.com`,
          password: "Correct-Horse-Battery-Staple-99",
          tenantName: `test-tenant-${tenantId}`,
        }),
      });
      expect(res.status).toBe(201);
    } finally {
      // Direct DB cleanup — see Section 6.3
      await db.query("DELETE FROM auth.users WHERE tenant_id = $1", [tenantId]);
    }
  });
});
```

---

## 9. Level 3 (Full Stack E2E) Pattern

Level 3 starts all services and exercises cross-service flows. The globalSetup spawns every service, waits for all health endpoints to return 200, then the test suite runs.

### 9.1 globalSetup.ts

```typescript
// tests/level3/globalSetup.ts

import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";

const SERVICE_MAP = [
  { name: "auth",      entry: "services/auth/dist/index.js",      port: 13001 },
  { name: "ingestion", entry: "services/ingestion/dist/index.js",  port: 13002 },
  { name: "ontology",  entry: "services/ontology/dist/index.js",   port: 13003 },
  { name: "pipeline",  entry: "services/pipeline/dist/index.js",   port: 13004 },
  { name: "app",       entry: "services/app/dist/index.js",        port: 13006 },
  { name: "plugin",    entry: "services/plugin/dist/index.js",     port: 13008 },
] as const;

const procs: ChildProcess[] = [];

export async function setup(): Promise<void> {
  const root = resolve(import.meta.dirname, "../..");

  for (const svc of SERVICE_MAP) {
    const proc = spawn("node", [resolve(root, svc.entry)], {
      env: {
        ...process.env,
        PORT: String(svc.port),
        OP_DATABASE_URL: process.env["OP_DATABASE_URL"]!,
        OP_REDIS_URL:    process.env["OP_REDIS_URL"]!,
        // Inter-service URLs — all point at test ports
        AUTH_SERVICE_URL:      "http://localhost:13001",
        INGESTION_SERVICE_URL: "http://localhost:13002",
        ONTOLOGY_SERVICE_URL:  "http://localhost:13003",
        EXECUTION_SERVICE_URL: "http://localhost:13005",
        PLUGIN_SERVICE_URL:    "http://localhost:13008",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout?.on("data", (d: Buffer) =>
      process.stdout.write(`[${svc.name}] ${d}`)
    );
    proc.stderr?.on("data", (d: Buffer) =>
      process.stderr.write(`[${svc.name}] ${d}`)
    );
    procs.push(proc);
  }

  // Wait for all services to be healthy in parallel
  await Promise.all(
    SERVICE_MAP.map((svc) =>
      waitForHealthy(`http://localhost:${svc.port}/healthz`, 60_000)
    )
  );
}

export async function teardown(): Promise<void> {
  for (const proc of procs) {
    proc.kill("SIGTERM");
  }
  await Promise.all(
    procs.map(
      (proc) => new Promise<void>((resolve) => proc.on("close", resolve))
    )
  );
}

async function waitForHealthy(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.status === 200) return;
    } catch { /* not ready */ }
    await new Promise<void>((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} not healthy after ${timeoutMs}ms`);
}
```

### 9.2 E2E test example — auth to ontology flow

```typescript
// tests/level3/auth-to-ontology.test.ts

import { describe, it, expect } from "vitest";
import { createDbClient } from "@oneplatform/core";
import { newTenantId } from "../helpers/tenant.js";

const AUTH_URL  = "http://localhost:13001";
const ONTOLOGY_URL = "http://localhost:13003";

const db = createDbClient({
  connectionString: process.env["OP_DATABASE_URL"]!,
  maxConnections: 2,
});

describe("E2E: tenant registers, then creates an ontology entity", () => {
  it("full flow", async () => {
    const tenantId = newTenantId();

    // Step 1: Register a tenant
    const regRes = await fetch(`${AUTH_URL}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: `e2e-${tenantId}@example.com`,
        password: "Correct-Horse-Battery-Staple-99",
        tenantName: `e2e-tenant-${tenantId}`,
      }),
    });
    expect(regRes.status).toBe(201);
    const { data: { accessToken } } = await regRes.json() as {
      data: { accessToken: string };
    };

    // Step 2: Create an entity in the ontology service
    const entityRes = await fetch(`${ONTOLOGY_URL}/api/v1/entities`, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        slug:   `product-${tenantId.slice(0, 8)}`,
        label:  "Product",
        fields: [{ name: "sku", type: "string", required: true }],
      }),
    });
    expect(entityRes.status).toBe(201);

    // Cleanup
    await db.query("DELETE FROM ontology.entities WHERE tenant_id = $1", [tenantId]);
    await db.query("DELETE FROM auth.users WHERE tenant_id = $1", [tenantId]);
  });
});
```

---

## 10. Service Init Container Secrets (W2)

In production, the init container generates `OP_MASTER_KEY`, `OP_JWT_SECRET`, and `OP_CURSOR_SECRET` on first start and writes them to `/data/init/`. Services read them at startup.

In tests, these secrets are provided via `.env.test` as environment variables. There is no init container in test mode. The service factory reads them from `process.env` directly.

For Level 1, the factory accepts them directly in its config parameter. For Level 2/3, they are injected via the spawn env (`...process.env` picks them up from the `.env.test` loader).

**Bootstrap token (auth service only):** In production, the bootstrap token is read from `/data/init/bootstrap.token`. In Level 1 tests, the factory accepts `bootstrapToken: string | null` directly, bypassing the filesystem. In Level 2/3 tests that exercise bootstrap, a temporary file is created in `beforeAll` and the `BOOTSTRAP_TOKEN_PATH` override env var is set in the spawn env:

```typescript
// In globalSetup or beforeAll for bootstrap tests:
import { writeFile, unlink, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const tmpDir = await mkdtemp(join(tmpdir(), "op-test-"));
const tokenPath = join(tmpDir, "bootstrap.token");
await writeFile(tokenPath, "a".repeat(64), "utf-8");
// Pass to service spawn: BOOTSTRAP_TOKEN_PATH=<tokenPath>
```

---

## 11. Service Keys Directory (W3)

**Current inconsistency in the codebase:**

| Service | Env var used |
|---|---|
| Auth | Hardcoded `/data/service-keys` (no env var override) |
| Ontology | Hardcoded `/data/service-keys` (no env var override) |
| Ingestion | Hardcoded `/data/service-keys` (no env var override) |
| Plugin | `OP_SERVICE_KEYS_DIR` with fallback `/data/service-keys` |
| Pipeline | `OP_SERVICE_KEYS_DIR` with fallback `/data/service-keys` |
| App | `SERVICE_KEYS_DIR` (different name) with fallback `/data/service-keys` |
| Execution | `OP_SERVICE_KEYS_DIR` with fallback `/data/service-keys` |

All `loadServicePublicKeys()` functions already have a `catch {}` block that returns `{}` on any error (ENOENT on the directory is swallowed). This means tests do not need to create a fake service keys directory — the function returns an empty map and service-to-service auth simply fails with 401 if attempted.

**For Level 1/2 tests:** Pass `OP_SERVICE_KEYS_DIR=/tmp/nonexistent-dir` (or leave it unset) — the function silently returns `{}`. Internal routes that require service auth are not exercised in Level 1. Level 3 tests that need inter-service calls must either generate real keys or use a shared test key pair.

**Recommended fix (not blocking tests, but should be done as a follow-up):** Normalize all services to use `OP_SERVICE_KEYS_DIR` with fallback `/data/service-keys`. App service has a typo (`SERVICE_KEYS_DIR` instead of `OP_SERVICE_KEYS_DIR`).

---

## 12. Key Test Scenarios

### 12.1 Auth service — Level 1

| Scenario | Test file |
|---|---|
| Bootstrap flow: status, bootstrap, attempt duplicate | `level1/bootstrap.test.ts` |
| Register → login → logout | `level1/login-flow.test.ts` |
| Forgot password → reset password | `level1/login-flow.test.ts` |
| Refresh token rotation | `level1/login-flow.test.ts` |
| API key: create, validate, revoke | `level1/api-keys.test.ts` |
| RBAC: assign role, check permission | `level1/rbac.test.ts` |
| Rate limit: 5 failed logins in 60s → locked | `level1/login-flow.test.ts` |

### 12.2 Ingestion service — Level 1

| Scenario | Test file |
|---|---|
| Connector: create, read, update, delete | `level1/connector-crud.test.ts` |
| Credential encryption round-trip | `level1/credentials.test.ts` |
| Webhook: register, receive payload, verify HMAC | `level1/webhooks.test.ts` |
| Upload: initiate job, simulate completion | `level1/uploads.test.ts` |

### 12.3 Ontology service — Level 1

| Scenario | Test file |
|---|---|
| Entity: create, update fields, soft-delete | `level1/entity-crud.test.ts` |
| Relationship: define, validate cardinality | `level1/relationships.test.ts` |
| Migration: start, status, cancel | `level1/migration-status.test.ts` |
| Mapping rule: create, validate, dry-run | `level1/mapping.test.ts` |

### 12.4 Pipeline service — Level 1

| Scenario | Test file |
|---|---|
| Pipeline: create, get, update | `level1/pipeline-crud.test.ts` |
| Run: trigger manual run, poll status | `level1/run-lifecycle.test.ts` |
| Schedule: create cron, list | `level1/schedules.test.ts` |

### 12.5 Plugin service — Level 1

| Scenario | Test file |
|---|---|
| Plugin manifest: register, list, get | `level1/plugin-crud.test.ts` |
| Instance: create, enable, disable | `level1/instance-lifecycle.test.ts` |
| Hook: register, verify hook payload shape | `level1/hooks.test.ts` |

### 12.6 App service — Level 1

| Scenario | Test file |
|---|---|
| App: create, get, update slug | `level1/app-crud.test.ts` |
| Version: create version, list | `level1/versions.test.ts` |
| Deployment: deploy version, check current | `level1/deployments.test.ts` |
| Permission: grant access, revoke | `level1/permissions.test.ts` |

### 12.7 Level 3 — Full stack flows

| Scenario | Test file |
|---|---|
| User registers, creates entity, creates pipeline reading that entity | `auth-to-ontology-to-pipeline.test.ts` |
| Ingestion connector write triggers pipeline via event trigger | `ingestion-pipeline.test.ts` |
| Plugin installed, hook fires during pipeline step | `plugin-hook-in-pipeline.test.ts` |
| App deployed, guest session issued, BFF call returns data | `app-deploy-and-serve.test.ts` |

---

## 13. CI Integration

### 13.1 CI pipeline steps

```yaml
# .github/workflows/integration-tests.yml (conceptual — adapt to your CI system)
jobs:
  integration:
    steps:
      - name: Start test infrastructure
        run: docker compose -f docker/docker-compose.test.yml up -d

      - name: Wait for infrastructure readiness
        run: |
          # Wait for PostgreSQL
          until pg_isready -h localhost -p 5433 -U op_test; do sleep 1; done
          # Wait for Redis
          until redis-cli -p 6380 ping | grep PONG; do sleep 1; done

      - name: Build all packages and services
        run: pnpm turbo run build
        # turbo.json test task already depends on build, but we run it
        # explicitly here so the step is visible in CI logs.

      - name: Run Level 1 integration tests
        run: pnpm turbo run test:integration:level1
        env:
          OP_DATABASE_URL: postgresql://op_test:op_test@localhost:5433/op_test
          OP_REDIS_URL:    redis://localhost:6380
          # Other OP_* vars from .env.test are loaded by vitest config

      - name: Run Level 2 integration tests
        run: pnpm turbo run test:integration:level2

      - name: Run Level 3 E2E tests
        run: pnpm test:e2e

      - name: Stop test infrastructure
        if: always()
        run: docker compose -f docker/docker-compose.test.yml down
```

### 13.2 turbo.json additions

Add these tasks to `turbo.json`:

```json
{
  "tasks": {
    "test:integration:level1": {
      "dependsOn": ["build"],
      "outputs": ["coverage/**"]
    },
    "test:integration:level2": {
      "dependsOn": ["build"],
      "outputs": []
    }
  }
}
```

The Level 3 E2E task is defined at the monorepo root, not per-package, so it does not go in turbo.json task definitions.

### 13.3 Package.json additions per service

```json
{
  "scripts": {
    "build":                  "tsc --project tsconfig.json",
    "test":                   "vitest run --passWithNoTests",
    "test:integration:level1": "vitest run --config vitest.integration.ts",
    "test:integration:level2": "vitest run --config vitest.integration-l2.ts"
  }
}
```

---

## 14. Implementation Order

Implement in this order to validate each layer before building on top of it:

**Step 1 — Infrastructure and helpers (no service changes)**
1. Write `docker/docker-compose.test.yml`
2. Commit `.env.test` to repository root
3. Write shared helpers: `tests/helpers/tenant.ts`, `tests/helpers/wait-for-ready.ts`

**Step 2 — Auth service (first, as all other services depend on tokens)**
1. Refactor `services/auth/src/index.ts` to export `createServiceApp()`
2. Write `services/auth/integration/helpers/test-app.ts` and `tenant.ts`
3. Write Level 1 tests: bootstrap, login flow, API keys, RBAC
4. Write Level 2 globalSetup and smoke test
5. Run, fix, confirm passing

**Step 3 — Ontology service**
1. Refactor `services/ontology/src/index.ts`
2. Write Level 1 tests: entity CRUD, relationships, migrations
3. Write Level 2 smoke test

**Step 4 — Ingestion service**
1. Refactor `services/ingestion/src/index.ts` (note: skip BullMQ workers in factory)
2. Write Level 1 tests: connector CRUD, credentials, webhooks
3. Write Level 2 smoke test

**Step 5 — Pipeline, Plugin, App services**
Same refactor + Level 1 + Level 2 pattern.

**Step 6 — Level 3 E2E**
1. Write `tests/level3/globalSetup.ts`
2. Write cross-service flows in priority order: auth-to-ontology, ingestion-pipeline, app-deploy

---

## 15. Security Considerations for Test Code

**Test credentials must not leak into production:**
- `.env.test` values are trivially weak. The `OP_JWT_SECRET` and `OP_MASTER_KEY` in `.env.test` are known values. Any data encrypted or signed with them in production would be compromised.
- Production deployments must generate their own secrets via the init container. The `.env.test` file has no path to production (no CI step deploys it).

**Test PostgreSQL user:**
- The `op_test` superuser should only exist in the test database container. It must not be created in production PostgreSQL.
- The `docker-compose.test.yml` container uses `tmpfs` for data storage — it is ephemeral and is destroyed on `docker compose down`.

**No real credentials in tests:**
- Connector credential tests use plaintext test strings. They are encrypted with the test `OP_MASTER_KEY`. If anyone examines the test database, the "credentials" are meaningless test strings.

---

## 16. Appendix: Complete env var reference for test setup

The following table covers every `OP_*` variable read by `loadConfig()` plus service-specific variables. All must be present or have defaults before `loadConfig()` is called in Level 1 tests.

| Variable | Required by loadConfig() | Test value (from .env.test) | Notes |
|---|---|---|---|
| `OP_MASTER_KEY` | Yes | `dGVzdG1hc3Rlcmtlc3RrZXkxMjM0NTY3ODkwYWJjZA==` | Must decode to exactly 32 bytes |
| `OP_JWT_SECRET` | Yes | `test-jwt-secret-for-integration-tests-32c` | Must be >= 32 chars |
| `OP_CURSOR_SECRET` | Yes | `test-cursor-secret-for-integration-32c` | Must be >= 32 chars |
| `OP_BASE_URL` | Yes | `http://localhost:3000` | URL format required |
| `OP_DATABASE_URL` | Yes | `postgresql://op_test:op_test@localhost:5433/op_test` | Points at test container |
| `OP_REDIS_URL` | Yes | `redis://localhost:6380` | Points at test container |
| `OP_ALLOWED_ORIGINS` | No (defaults to `http://localhost:3000`) | `http://localhost:3000` | |
| `OP_GLOBAL_RATE_LIMIT` | No (defaults to 10000) | `10000` | |
| `OP_SANDBOX_POOL_SIZE` | No (defaults to 5) | `1` | Smaller pool for tests |
| `OP_CONNECTOR_TIMEOUT_SECONDS` | No (defaults to 300) | `10` | Fast timeout for tests |
| `OP_INGESTION_BATCH_SIZE` | No (defaults to 1000) | `100` | |
| `OP_LARGE_SYNC_CONCURRENCY` | No (defaults to 3) | `1` | |
| `OP_MIGRATION_TIMEOUT` | No (defaults to 3600) | `60` | |
| `OP_ONTOLOGY_POLL_INTERVAL` | No (defaults to 15) | `1` | Faster for tests |
| `OP_REQUIRE_EMAIL_VERIFICATION` | No (defaults to false) | `false` | Skip email in tests |
| `OP_WEBHOOK_ALLOW_HTTP` | No (defaults to false) | `true` | Allow http:// in tests |
| `PORT` | Not loadConfig() — read directly | Per service (Level 2/3 only) | See Section 5.2 |
| `OP_SERVICE_TOKEN_SECRET` | Not loadConfig() — read directly in plugin service | `test-service-token-secret-not-real` | |
| `OP_SERVICE_KEYS_DIR` | Not loadConfig() — read in loadServicePublicKeys() | Not set (returns {} on ENOENT) | |
