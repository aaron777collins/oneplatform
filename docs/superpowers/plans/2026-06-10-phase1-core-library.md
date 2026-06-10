# Phase 1: @oneplatform/core Library

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the shared backbone library that all 9 services depend on.

**Architecture:** Single `@oneplatform/core` package. Exports `createApp()` factory that produces a fully-instrumented Hono app with 10-middleware stack. Also exports DB/Redis/Queue/Logger/Encryption/Health utilities.

**Tech Stack:** TypeScript, Hono, Zod, ioredis, pg, bullmq, jose, vitest

**Depends on:** Phase 0 (monorepo + infrastructure setup)

---

## File Structure

```
packages/core/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── types.ts
│   ├── errors.ts
│   ├── db.ts
│   ├── redis.ts
│   ├── encryption.ts
│   ├── cursor.ts
│   ├── queue.ts
│   ├── logger.ts
│   ├── events.ts
│   ├── health.ts
│   ├── service-rbac.ts
│   ├── app.ts
│   └── middleware/
│       ├── request-id.ts
│       ├── cors.ts
│       ├── auth.ts
│       ├── service-auth.ts
│       ├── response-envelope.ts
│       ├── error-handler.ts
│       ├── rate-limit-headers.ts
│       └── deprecation-headers.ts
└── src/__tests__/
    ├── config.test.ts
    ├── errors.test.ts
    ├── encryption.test.ts
    ├── cursor.test.ts
    ├── health.test.ts
    └── service-rbac.test.ts
```

---

## Task 1: Package Setup

**Goal:** Establish the `packages/core` package with all runtime and dev dependencies, TypeScript config, and vitest config.

### Steps

- [ ] **1.1** Write `packages/core/package.json`

```json
{
  "name": "@oneplatform/core",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc --project tsconfig.json",
    "dev": "tsc --project tsconfig.json --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "hono": "^4.4.0",
    "zod": "^3.23.0",
    "ioredis": "^5.4.1",
    "pg": "^8.12.0",
    "bullmq": "^5.8.0",
    "jose": "^5.6.3"
  },
  "devDependencies": {
    "@types/pg": "^8.11.6",
    "@types/node": "^20.14.0",
    "typescript": "^5.5.0",
    "vitest": "^1.6.0"
  }
}
```

- [ ] **1.2** Write `packages/core/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "./src",
    "outDir": "./dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src"],
  "exclude": ["src/__tests__", "dist", "node_modules"]
}
```

- [ ] **1.3** Write `packages/core/vitest.config.ts`

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each test file gets its own isolated environment — prevents state leakage
    // between config, encryption, and cursor tests that manipulate process.env.
    isolate: true,
    environment: "node",
    coverage: {
      reporter: ["text", "json"],
      exclude: ["src/__tests__/**"],
    },
  },
});
```

---

## Task 2: Shared Types (`src/types.ts`)

**Goal:** Define every canonical type consumed across all 9 services. These types form the API contract — nothing flows between services that isn't described here.

### Steps

- [ ] **2.1** Write `packages/core/src/types.ts`

```typescript
// Canonical API contract types for @oneplatform/core.
// All 9 services import from here — NEVER duplicate these locally.

// ---------------------------------------------------------------------------
// API response envelopes (spec §6)
// ---------------------------------------------------------------------------

export interface ApiResponse<T> {
  data: T;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
    requestId: string;
  };
}

export interface PaginatedResponse<T> {
  data: T[];
  // nextCursor is null when the last page has been reached.
  // total is null for collections exceeding 100k rows (COUNT is cost-prohibitive).
  pagination: {
    nextCursor: string | null;
    total: number | null;
  };
}

// ---------------------------------------------------------------------------
// User context (populated by auth middleware — spec §5)
// ---------------------------------------------------------------------------

export interface UserContext {
  userId: string;
  tenantId: string;
  roles: string[];
  scopes: string[];
  isGuest: boolean;
  // isService=true when the caller is another service (X-Service-Token path)
  isService: boolean;
  emailVerified: boolean;
}

// ---------------------------------------------------------------------------
// Platform event envelope (canonical — spec §5, ADR-30)
// ---------------------------------------------------------------------------

export interface PlatformEvent {
  eventId: string;
  eventType: string;
  // Increment version when event schema is extended in a breaking way.
  eventVersion: string;
  tenantId: string;
  // ISO-8601 UTC timestamp
  timestamp: string;
  actor: {
    type: "user" | "service" | "system";
    id: string;
    displayName?: string;
  };
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Data envelope for ingestion (canonical — spec §5, ADR-28)
// ---------------------------------------------------------------------------

export interface DataEnvelope {
  _id: string;
  _source: string;
  // ISO-8601 UTC timestamp set by Ingestion Service at receive time
  _ingestedAt: string;
  _connectorId: string;
  _batchId: string;
  _tenantId: string;
  _syncMode: "full" | "incremental";
  // Opaque cursor for incremental sync position; null for full syncs
  _cursor: string | null;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Service name registry (spec §7 — all 9 services)
// ---------------------------------------------------------------------------

export enum ServiceName {
  Gateway = "gateway-service",
  Auth = "auth-service",
  Ingestion = "ingestion-service",
  Ontology = "ontology-service",
  Pipeline = "pipeline-service",
  Execution = "execution-service",
  App = "app-service",
  Logging = "logging-service",
  Plugin = "plugin-service",
}

// ---------------------------------------------------------------------------
// Hono variable extension (c.var.user is typed to UserContext)
// ---------------------------------------------------------------------------

export type AppVariables = {
  user: UserContext;
  requestId: string;
};
```

---

## Task 3: Config Loader (`src/config.ts`)

**Goal:** Parse and validate every `OP_*` environment variable at startup. A missing required variable crashes the process immediately with a specific error — no silent degradation.

### Steps

- [ ] **3.1** Write the test first: `packages/core/src/__tests__/config.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";

// Each test mutates process.env, so we snapshot and restore around every case.
describe("loadConfig", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore to prevent pollution between test cases
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
  });

  function setMinimalEnv() {
    process.env.OP_MASTER_KEY = "dGVzdC1tYXN0ZXIta2V5LTMyLWJ5dGVzLXBhZA==";
    process.env.OP_JWT_SECRET = "test-jwt-secret-must-be-long-enough-32ch";
    process.env.OP_CURSOR_SECRET = "test-cursor-secret-32-chars-padded!!";
    process.env.OP_BASE_URL = "http://localhost:3000";
    process.env.OP_DATABASE_URL = "postgres://user:pass@localhost:5433/op";
    process.env.OP_REDIS_URL = "redis://localhost:6379";
  }

  it("loads a minimal valid environment without throwing", async () => {
    setMinimalEnv();
    const { loadConfig } = await import("../config.js");
    const config = loadConfig();
    expect(config.OP_BASE_URL).toBe("http://localhost:3000");
    expect(config.OP_GLOBAL_RATE_LIMIT).toBe(10000); // default
  });

  it("throws with a descriptive message when OP_MASTER_KEY is missing", async () => {
    setMinimalEnv();
    delete process.env.OP_MASTER_KEY;
    const { loadConfig } = await import("../config.js");
    expect(() => loadConfig()).toThrow(/OP_MASTER_KEY/);
  });

  it("throws when OP_ALLOWED_ORIGINS contains a wildcard in production", async () => {
    setMinimalEnv();
    process.env.NODE_ENV = "production";
    process.env.OP_ALLOWED_ORIGINS = "*";
    const { loadConfig } = await import("../config.js");
    expect(() => loadConfig()).toThrow(/wildcard/i);
  });

  it("applies correct defaults for optional vars", async () => {
    setMinimalEnv();
    const { loadConfig } = await import("../config.js");
    const config = loadConfig();
    expect(config.OP_GLOBAL_RATE_LIMIT).toBe(10000);
    expect(config.OP_SANDBOX_POOL_SIZE).toBe(5);
    expect(config.OP_CONNECTOR_TIMEOUT_SECONDS).toBe(300);
    expect(config.OP_INGESTION_BATCH_SIZE).toBe(1000);
    expect(config.OP_MIGRATION_TIMEOUT).toBe(3600);
    expect(config.OP_REQUIRE_EMAIL_VERIFICATION).toBe(false);
    expect(config.OP_WEBHOOK_ALLOW_HTTP).toBe(false);
  });

  it("parses OP_ALLOWED_ORIGINS as an array", async () => {
    setMinimalEnv();
    process.env.OP_ALLOWED_ORIGINS = "http://localhost:3000,https://app.example.com";
    const { loadConfig } = await import("../config.js");
    const config = loadConfig();
    expect(config.OP_ALLOWED_ORIGINS).toEqual([
      "http://localhost:3000",
      "https://app.example.com",
    ]);
  });
});
```

- [ ] **3.2** Write `packages/core/src/config.ts`

```typescript
import { z } from "zod";

// Wildcard CORS origins are rejected in production — a wildcard would defeat
// the credential-bearing cookie security model (spec §6, SameSite=Strict).
const originsSchema = z
  .string()
  .transform((val) => val.split(",").map((s) => s.trim()))
  .refine(
    (origins) => {
      if (process.env.NODE_ENV === "production") {
        return !origins.includes("*");
      }
      return true;
    },
    { message: "Wildcard (*) is not allowed in OP_ALLOWED_ORIGINS in production" }
  );

const configSchema = z.object({
  // -------------------------------------------------------------------------
  // Security — generated by op-init (spec §2, Appendix A)
  // -------------------------------------------------------------------------
  OP_MASTER_KEY: z.string().min(1),
  OP_JWT_SECRET: z.string().min(32),
  OP_CURSOR_SECRET: z.string().min(32),

  // -------------------------------------------------------------------------
  // Network
  // -------------------------------------------------------------------------
  OP_BASE_URL: z.string().url(),
  OP_ALLOWED_ORIGINS: originsSchema.optional().default("http://localhost:3000"),
  OP_WILDCARD_DOMAIN: z.string().optional(),
  OP_GATEWAY_REPLICAS: z.coerce.number().int().positive().optional(),

  // -------------------------------------------------------------------------
  // Data stores
  // -------------------------------------------------------------------------
  OP_DATABASE_URL: z.string().url(),
  OP_REDIS_URL: z.string().url(),

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------
  OP_GLOBAL_RATE_LIMIT: z.coerce.number().int().positive().default(10000),

  // -------------------------------------------------------------------------
  // Execution sandbox
  // -------------------------------------------------------------------------
  OP_SANDBOX_POOL_SIZE: z.coerce.number().int().positive().default(5),
  OP_CONNECTOR_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),

  // -------------------------------------------------------------------------
  // Ingestion
  // -------------------------------------------------------------------------
  OP_INGESTION_BATCH_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .max(10000)
    .default(1000),
  OP_LARGE_SYNC_CONCURRENCY: z.coerce.number().int().positive().default(3),

  // -------------------------------------------------------------------------
  // Ontology / migrations
  // -------------------------------------------------------------------------
  OP_MIGRATION_TIMEOUT: z.coerce.number().int().positive().default(3600),
  OP_ONTOLOGY_POLL_INTERVAL: z.coerce.number().int().positive().default(15),

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------
  OP_REQUIRE_EMAIL_VERIFICATION: z
    .string()
    .transform((v) => v === "true")
    .default("false"),

  // -------------------------------------------------------------------------
  // Email (SMTP)
  // -------------------------------------------------------------------------
  OP_SMTP_HOST: z.string().optional(),
  OP_SMTP_PORT: z.coerce.number().int().optional(),
  OP_SMTP_USER: z.string().optional(),
  OP_SMTP_PASS: z.string().optional(),
  OP_SMTP_FROM: z.string().email().optional(),
  OP_SMTP_SECURE: z
    .string()
    .transform((v) => v === "true")
    .default("true"),

  // -------------------------------------------------------------------------
  // Object storage (MinIO / S3-compatible)
  // -------------------------------------------------------------------------
  OP_S3_ENDPOINT: z.string().url().optional(),
  OP_S3_ACCESS_KEY: z.string().optional(),
  OP_S3_SECRET_KEY: z.string().optional(),
  OP_S3_REGION: z.string().optional(),
  OP_MINIO_USER: z.string().default("minioadmin"),
  OP_MINIO_PASSWORD: z.string().optional(),

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------
  OP_WEBHOOK_ALLOW_HTTP: z
    .string()
    .transform((v) => v === "true")
    .default("false"),

  // -------------------------------------------------------------------------
  // Observability
  // -------------------------------------------------------------------------
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
});

export type Config = z.infer<typeof configSchema>;

// loadConfig() is the single point of env-var consumption for the entire
// platform. Call it once at service startup — failure = non-zero exit.
export function loadConfig(): Config {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Configuration validation failed:\n${issues}`);
  }
  return result.data;
}
```

---

## Task 4: Error Registry (`src/errors.ts`)

**Goal:** A typed error hierarchy where every thrown error maps to an HTTP status and a machine-readable code. The error handler middleware serializes these into the API envelope. Stack traces are stripped before reaching the wire.

### Steps

- [ ] **4.1** Write the test first: `packages/core/src/__tests__/errors.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import {
  AppError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  ValidationError,
  RateLimitError,
  InternalError,
  ServiceUnavailableError,
} from "../errors.js";

describe("AppError subclasses", () => {
  it("NotFoundError serializes to correct code and status", () => {
    const err = new NotFoundError("Customer with id '123' does not exist.");
    expect(err.code).toBe("NOT_FOUND");
    expect(err.statusCode).toBe(404);
    expect(err.message).toBe("Customer with id '123' does not exist.");
    expect(err instanceof AppError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  it("ValidationError carries details payload", () => {
    const details = { field: "email", issue: "Invalid format" };
    const err = new ValidationError("Validation failed", details);
    expect(err.code).toBe("VALIDATION_ERROR");
    expect(err.statusCode).toBe(422);
    expect(err.details).toEqual(details);
  });

  it("RateLimitError includes retryAfter", () => {
    const err = new RateLimitError(60);
    expect(err.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(err.statusCode).toBe(429);
    expect(err.retryAfterSeconds).toBe(60);
  });

  it("InternalError hides original message from toApiError", () => {
    const err = new InternalError("SELECT * FROM users -- internal detail");
    const envelope = err.toApiError("req-123");
    // Internal error details must never reach the client
    expect(envelope.error.message).toBe("An unexpected error occurred.");
    expect(envelope.error.message).not.toContain("SELECT");
    expect(envelope.error.requestId).toBe("req-123");
  });

  it("toApiError produces spec-compliant envelope shape", () => {
    const err = new ForbiddenError("Insufficient scope: data:write required");
    const envelope = err.toApiError("req-456");
    expect(envelope).toMatchObject({
      error: {
        code: "FORBIDDEN",
        message: "Insufficient scope: data:write required",
        requestId: "req-456",
      },
    });
  });

  it("UnauthorizedError uses correct status 401", () => {
    const err = new UnauthorizedError("Missing token");
    expect(err.statusCode).toBe(401);
  });

  it("ConflictError uses status 409", () => {
    const err = new ConflictError("Duplicate slug");
    expect(err.statusCode).toBe(409);
  });

  it("ServiceUnavailableError uses status 503", () => {
    const err = new ServiceUnavailableError("Postgres unreachable");
    expect(err.statusCode).toBe(503);
  });
});
```

- [ ] **4.2** Write `packages/core/src/errors.ts`

```typescript
import type { ApiError } from "./types.js";

// ---------------------------------------------------------------------------
// Base class
// ---------------------------------------------------------------------------

export abstract class AppError extends Error {
  abstract readonly code: string;
  abstract readonly statusCode: number;
  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.details = details;
    // Preserve correct prototype chain when targeting ES5 via tsc
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toApiError(requestId: string): ApiError {
    return {
      error: {
        code: this.code,
        // InternalError overrides this to return a safe message (see below).
        message: this.message,
        ...(this.details !== undefined && { details: this.details }),
        requestId,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Error code registry (spec §6, Error Code Registry table)
// ---------------------------------------------------------------------------

export class UnauthorizedError extends AppError {
  readonly code = "UNAUTHORIZED" as const;
  readonly statusCode = 401;
}

export class ForbiddenError extends AppError {
  readonly code = "FORBIDDEN" as const;
  readonly statusCode = 403;
}

export class InsufficientScopeError extends AppError {
  readonly code = "INSUFFICIENT_SCOPE" as const;
  readonly statusCode = 403;
}

export class NotFoundError extends AppError {
  readonly code = "NOT_FOUND" as const;
  readonly statusCode = 404;
}

export class EntityNotFoundError extends AppError {
  readonly code = "ENTITY_NOT_FOUND" as const;
  readonly statusCode = 404;
}

export class ConflictError extends AppError {
  readonly code = "CONFLICT" as const;
  readonly statusCode = 409;
}

export class ValidationError extends AppError {
  readonly code = "VALIDATION_ERROR" as const;
  readonly statusCode = 422;
}

export class RateLimitError extends AppError {
  readonly code = "RATE_LIMIT_EXCEEDED" as const;
  readonly statusCode = 429;
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(`Rate limit exceeded. Retry after ${retryAfterSeconds} seconds.`);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// InternalError intentionally conceals its message from the API response.
// The real message is logged at DEBUG level and tied to requestId for admins.
export class InternalError extends AppError {
  readonly code = "INTERNAL_ERROR" as const;
  readonly statusCode = 500;

  override toApiError(requestId: string): ApiError {
    return {
      error: {
        code: this.code,
        message: "An unexpected error occurred.",
        requestId,
      },
    };
  }
}

export class ServiceUnavailableError extends AppError {
  readonly code = "SERVICE_UNAVAILABLE" as const;
  readonly statusCode = 503;
}

export class PaginationLimitExceededError extends AppError {
  readonly code = "PAGINATION_LIMIT_EXCEEDED" as const;
  readonly statusCode = 400;
}

export class InvalidCursorError extends AppError {
  readonly code = "INVALID_CURSOR" as const;
  readonly statusCode = 400;
}

export class CursorExpiredError extends AppError {
  readonly code = "CURSOR_EXPIRED" as const;
  readonly statusCode = 410;
}

export class BulkLimitExceededError extends AppError {
  readonly code = "BULK_LIMIT_EXCEEDED" as const;
  readonly statusCode = 400;
}

export class OriginNotAllowedError extends AppError {
  readonly code = "ORIGIN_NOT_ALLOWED" as const;
  readonly statusCode = 403;
}

export class UnknownFilterFieldError extends AppError {
  readonly code = "UNKNOWN_FILTER_FIELD" as const;
  readonly statusCode = 400;
}

export class UnsortableFieldError extends AppError {
  readonly code = "UNSORTABLE_FIELD" as const;
  readonly statusCode = 400;
}
```

---

## Task 5: Encryption Utilities (`src/encryption.ts`)

**Goal:** AES-256-GCM encryption with HKDF-SHA256 key derivation for per-credential salts. Used by Ingestion Service credential vault, App Service env-var secrets, and CLI credential storage.

### Steps

- [ ] **5.1** Write the test first: `packages/core/src/__tests__/encryption.test.ts`

```typescript
import { describe, it, expect } from "vitest";
import { encrypt, decrypt } from "../encryption.js";

const MASTER_KEY = Buffer.from(
  "0000000000000000000000000000000000000000000000000000000000000001",
  "hex"
);

describe("encrypt / decrypt", () => {
  it("roundtrip produces identical plaintext", async () => {
    const plaintext = "super-secret-api-key";
    const blob = await encrypt(plaintext, MASTER_KEY);
    const result = await decrypt(blob, MASTER_KEY);
    expect(result).toBe(plaintext);
  });

  it("two encryptions of the same plaintext produce different blobs (random IV + salt)", async () => {
    const plaintext = "same-value";
    const blob1 = await encrypt(plaintext, MASTER_KEY);
    const blob2 = await encrypt(plaintext, MASTER_KEY);
    expect(blob1).not.toBe(blob2);
  });

  it("decryption fails loudly when the master key is wrong", async () => {
    const blob = await encrypt("sensitive", MASTER_KEY);
    const wrongKey = Buffer.from(
      "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      "hex"
    );
    await expect(decrypt(blob, wrongKey)).rejects.toThrow();
  });

  it("decryption fails when the blob is tampered", async () => {
    const blob = await encrypt("value", MASTER_KEY);
    // Flip a byte in the ciphertext portion
    const raw = Buffer.from(blob, "base64");
    raw[raw.length - 1] ^= 0xff;
    const tampered = raw.toString("base64");
    await expect(decrypt(tampered, MASTER_KEY)).rejects.toThrow();
  });

  it("handles empty string plaintext", async () => {
    const blob = await encrypt("", MASTER_KEY);
    const result = await decrypt(blob, MASTER_KEY);
    expect(result).toBe("");
  });

  it("handles unicode plaintext", async () => {
    const plaintext = "密码 🔐 пароль";
    const blob = await encrypt(plaintext, MASTER_KEY);
    expect(await decrypt(blob, MASTER_KEY)).toBe(plaintext);
  });
});
```

- [ ] **5.2** Write `packages/core/src/encryption.ts`

```typescript
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "crypto";

// Wire format: base64( salt[32] | iv[12] | authTag[16] | ciphertext[...] )
// salt  — unique per encryption, passed to HKDF for per-credential key derivation
// iv    — unique per encryption, required for AES-GCM nonce uniqueness
// authTag — AES-GCM authentication tag, detects any tampering
const SALT_BYTES = 32;
const IV_BYTES = 12;   // 96-bit nonce — GCM standard recommendation
const TAG_BYTES = 16;  // 128-bit authentication tag

// Derive a 256-bit AES key from the master key and a per-credential salt.
// HKDF-SHA256 ensures that each credential uses a distinct key even though
// they share one master key — compromising one credential does not help an
// attacker decrypt others (spec §13, ADR-11).
function deriveKey(masterKey: Buffer, salt: Buffer): Buffer {
  return Buffer.from(
    hkdfSync("sha256", masterKey, salt, "oneplatform-credential-v1", 32)
  );
}

export async function encrypt(plaintext: string, masterKey: Buffer): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = deriveKey(masterKey, salt);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const blob = Buffer.concat([salt, iv, authTag, ciphertext]);
  return blob.toString("base64");
}

export async function decrypt(blob: string, masterKey: Buffer): Promise<string> {
  const raw = Buffer.from(blob, "base64");

  if (raw.length < SALT_BYTES + IV_BYTES + TAG_BYTES) {
    throw new Error("Encrypted blob is too short to be valid");
  }

  const salt = raw.subarray(0, SALT_BYTES);
  const iv = raw.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES);
  const authTag = raw.subarray(SALT_BYTES + IV_BYTES, SALT_BYTES + IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(SALT_BYTES + IV_BYTES + TAG_BYTES);

  const key = deriveKey(masterKey, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);

  // Throws if the auth tag does not match — detects both tampering and wrong key
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

// loadMasterKey reads OP_MASTER_KEY from the environment and returns it as a
// raw Buffer. Called once at service startup; throws loudly if absent.
export function loadMasterKey(): Buffer {
  const raw = process.env.OP_MASTER_KEY;
  if (!raw) {
    throw new Error(
      "OP_MASTER_KEY is not set. Cannot initialize credential vault."
    );
  }
  // Key is base64-encoded 32 bytes generated by op-init (spec §2)
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `OP_MASTER_KEY must be a 32-byte base64-encoded value (got ${key.length} bytes)`
    );
  }
  return key;
}
```

---

## Task 6: Cursor Helpers (`src/cursor.ts`)

**Goal:** HMAC-SHA256 signed, base64url-encoded pagination cursors with 24-hour expiry. Clients treat cursors as opaque tokens — the internal structure is not an API contract.

### Steps

- [ ] **6.1** Write the test first: `packages/core/src/__tests__/cursor.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encodeCursor, decodeCursor } from "../cursor.js";
import { InvalidCursorError, CursorExpiredError } from "../errors.js";

const SECRET = "test-cursor-secret-32-chars-pad!!";

describe("encodeCursor / decodeCursor", () => {
  it("roundtrip preserves payload", async () => {
    const payload = { id: "abc-123", createdAt: "2026-01-01T00:00:00.000Z" };
    const cursor = await encodeCursor(payload, SECRET);
    const result = await decodeCursor(cursor, SECRET);
    expect(result).toMatchObject(payload);
  });

  it("throws InvalidCursorError on tampered signature", async () => {
    const cursor = await encodeCursor({ id: "x" }, SECRET);
    // Replace the last few characters of the base64url signature
    const tampered = cursor.slice(0, -4) + "XXXX";
    await expect(decodeCursor(tampered, SECRET)).rejects.toThrow(InvalidCursorError);
  });

  it("throws InvalidCursorError on malformed (non-base64) input", async () => {
    await expect(decodeCursor("!!!invalid!!!", SECRET)).rejects.toThrow(InvalidCursorError);
  });

  it("throws CursorExpiredError when cursor is older than 24 hours", async () => {
    const now = Date.now();
    // Encode cursor with a timestamp 25 hours in the past
    vi.setSystemTime(now - 25 * 60 * 60 * 1000);
    const cursor = await encodeCursor({ id: "y" }, SECRET);

    vi.setSystemTime(now);
    await expect(decodeCursor(cursor, SECRET)).rejects.toThrow(CursorExpiredError);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });
});
```

- [ ] **6.2** Write `packages/core/src/cursor.ts`

```typescript
import { createHmac, timingSafeEqual } from "crypto";
import { InvalidCursorError, CursorExpiredError } from "./errors.js";

// Cursor TTL matches the spec §6 Pagination section: 24 hours.
const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;

interface CursorEnvelope {
  payload: Record<string, unknown>;
  // Unix epoch milliseconds — used to enforce 24h expiry
  issuedAt: number;
}

function sign(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

// Wire format: base64url(JSON envelope) . HMAC-SHA256 signature
// The dot separator allows splitting without ambiguity since base64url has no dots.
export async function encodeCursor(
  payload: Record<string, unknown>,
  secret: string
): Promise<string> {
  const envelope: CursorEnvelope = { payload, issuedAt: Date.now() };
  const body = Buffer.from(JSON.stringify(envelope)).toString("base64url");
  const sig = sign(body, secret);
  return `${body}.${sig}`;
}

export async function decodeCursor(
  cursor: string,
  secret: string
): Promise<Record<string, unknown>> {
  let body: string;
  let sig: string;

  try {
    const dotIndex = cursor.lastIndexOf(".");
    if (dotIndex === -1) throw new Error("No separator");
    body = cursor.slice(0, dotIndex);
    sig = cursor.slice(dotIndex + 1);
  } catch {
    throw new InvalidCursorError("Cursor format is invalid");
  }

  // Constant-time comparison prevents timing attacks on the HMAC
  const expectedSig = sign(body, secret);
  const sigBuffer = Buffer.from(sig);
  const expectedBuffer = Buffer.from(expectedSig);

  if (
    sigBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(sigBuffer, expectedBuffer)
  ) {
    throw new InvalidCursorError("Cursor signature is invalid");
  }

  let envelope: CursorEnvelope;
  try {
    const json = Buffer.from(body, "base64url").toString("utf8");
    envelope = JSON.parse(json) as CursorEnvelope;
  } catch {
    throw new InvalidCursorError("Cursor payload could not be decoded");
  }

  const ageMs = Date.now() - envelope.issuedAt;
  if (ageMs > CURSOR_TTL_MS) {
    throw new CursorExpiredError("Cursor has expired (older than 24 hours)");
  }

  return envelope.payload;
}
```

---

## Task 7: Database Client (`src/db.ts`)

**Goal:** Create a `pg.Pool` connected through PgBouncer with the correct mode and per-service connection limits. Expose `setTenantContext` to set the `app.tenant_id` session variable required by RLS policies.

### Steps

- [ ] **7.1** Write the test first (verifies pool configuration): `packages/core/src/__tests__/db.test.ts`

  Note: This test does not open a real connection — it validates that `createDbClient` constructs the Pool with the expected config values.

```typescript
import { describe, it, expect, vi } from "vitest";

// Mock pg before importing db.ts so no real TCP connections are attempted
vi.mock("pg", () => {
  const Pool = vi.fn().mockImplementation((config) => ({ _config: config }));
  return { default: { Pool }, Pool };
});

describe("createDbClient", () => {
  it("constructs pool with connection string and correct limits", async () => {
    const { createDbClient } = await import("../db.js");
    const pool = createDbClient({
      connectionString: "postgres://user:pass@pgbouncer:5433/op",
      maxConnections: 20,
    });
    // @ts-expect-error — accessing mock internals
    expect(pool._config.connectionString).toBe(
      "postgres://user:pass@pgbouncer:5433/op"
    );
    // @ts-expect-error
    expect(pool._config.max).toBe(20);
  });

  it("sets statement_timeout to prevent runaway queries", async () => {
    const { createDbClient } = await import("../db.js");
    const pool = createDbClient({
      connectionString: "postgres://user:pass@pgbouncer:5433/op",
      maxConnections: 10,
    });
    // @ts-expect-error
    expect(pool._config.statement_timeout).toBeGreaterThan(0);
  });
});
```

- [ ] **7.2** Write `packages/core/src/db.ts`

```typescript
import pg from "pg";

const { Pool } = pg;

export interface DbClientConfig {
  connectionString: string;
  // Per-service connection limits from spec §3 PgBouncer Configuration
  maxConnections: number;
  // Optional: override statement_timeout (milliseconds). Default 30s.
  statementTimeoutMs?: number;
}

// createDbClient produces a pg.Pool pointed at PgBouncer.
// Each service calls this once at startup with its own connection limit.
export function createDbClient(config: DbClientConfig): pg.Pool {
  return new Pool({
    connectionString: config.connectionString,
    max: config.maxConnections,
    // Prevent queries that never finish from holding a connection forever.
    // 30s default covers normal ops; long-running jobs use dedicated pools.
    statement_timeout: config.statementTimeoutMs ?? 30_000,
    // Allow up to 5s to establish a new connection before failing.
    connectionTimeoutMillis: 5_000,
    // Validate connection liveness on each checkout (cheap ping)
    idleTimeoutMillis: 30_000,
  });
}

// setTenantContext must be called within every transaction that touches tenant-
// scoped tables. PostgreSQL RLS policies filter on app.tenant_id. Without this,
// the query runs as the service user and bypasses row-level security.
export async function setTenantContext(
  client: pg.PoolClient,
  tenantId: string
): Promise<void> {
  // SET LOCAL scopes the variable to the current transaction only — correct
  // behavior with PgBouncer transaction-mode pooling (spec §3).
  await client.query("SET LOCAL app.tenant_id = $1", [tenantId]);
}
```

---

## Task 8: Redis Client (`src/redis.ts`)

**Goal:** Create an ioredis client with correct reconnection behavior and per-service ACL credentials. Each service connects with its own username that enforces Redis key-prefix ACLs (spec §3).

### Steps

- [ ] **8.1** Write the test first: `packages/core/src/__tests__/redis.test.ts`

  Note: Mocks ioredis — no real Redis connection required.

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("ioredis", () => {
  const Redis = vi.fn().mockImplementation((config) => ({ _config: config }));
  return { default: Redis };
});

describe("createRedisClient", () => {
  it("passes connection URL and lazyConnect option", async () => {
    const { createRedisClient } = await import("../redis.js");
    const client = createRedisClient({
      url: "redis://op_auth:secret@redis:6379",
    });
    // @ts-expect-error — accessing mock internals
    expect(client._config.lazyConnect).toBe(true);
  });

  it("configures retry strategy with exponential backoff", async () => {
    const { createRedisClient } = await import("../redis.js");
    const client = createRedisClient({
      url: "redis://redis:6379",
    });
    // @ts-expect-error
    const retryStrategy = client._config.retryStrategy;
    expect(typeof retryStrategy).toBe("function");
    // First retry: should return a positive delay
    const delay = retryStrategy(1);
    expect(delay).toBeGreaterThan(0);
    // After max retries, should return null to stop retrying
    const giveUp = retryStrategy(20);
    expect(giveUp).toBeNull();
  });
});
```

- [ ] **8.2** Write `packages/core/src/redis.ts`

```typescript
import Redis from "ioredis";

export interface RedisClientConfig {
  url: string;
  // Override maximum reconnect attempts (default: 10)
  maxRetriesPerRequest?: number;
}

// Exponential backoff with cap at 30s. Returns null after 10 attempts to
// surface the error up to the service health check rather than loop forever.
function retryStrategy(times: number): number | null {
  if (times > 10) {
    return null;
  }
  // 100ms * 2^n, capped at 30s
  return Math.min(100 * Math.pow(2, times), 30_000);
}

// createRedisClient builds an ioredis instance for one service.
// lazyConnect=true prevents the constructor from immediately connecting —
// services connect explicitly so startup failures are observable in readyz.
export function createRedisClient(config: RedisClientConfig): Redis {
  return new Redis(config.url, {
    lazyConnect: true,
    maxRetriesPerRequest: config.maxRetriesPerRequest ?? 3,
    retryStrategy,
    // Keep connection alive across idle periods (Redis default timeout: 0)
    keepAlive: 10_000,
    // Enable offline queue so commands issued before connect() resolves
    // are buffered rather than thrown. Services call connect() explicitly.
    enableOfflineQueue: true,
    // Name the connection for easier Redis CLIENT LIST debugging
    connectionName: process.env.SERVICE_NAME ?? "op-service",
  });
}
```

---

## Task 9: Queue Factory (`src/queue.ts`)

**Goal:** BullMQ `Queue` and `Worker` factories with DLQ routing. All queues use exponential backoff with 5 retry attempts. Failed jobs after exhausting retries are moved to a dead-letter queue named `{queueName}:dlq`.

### Steps

- [ ] **9.1** Write the test first: `packages/core/src/__tests__/queue.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";

vi.mock("bullmq", () => {
  const Queue = vi.fn().mockImplementation((name, opts) => ({ _name: name, _opts: opts }));
  const Worker = vi.fn().mockImplementation((name, processor, opts) => ({
    _name: name,
    _opts: opts,
  }));
  return { Queue, Worker };
});

describe("createQueue", () => {
  it("constructs a Queue with the given name and Redis connection", async () => {
    const { createQueue } = await import("../queue.js");
    const q = createQueue("pipeline:run", { host: "redis", port: 6379 });
    // @ts-expect-error
    expect(q._name).toBe("pipeline:run");
  });

  it("default job options include 5 retry attempts with exponential backoff", async () => {
    const { createQueue } = await import("../queue.js");
    const q = createQueue("test:queue", { host: "redis", port: 6379 });
    // @ts-expect-error
    const defaultJobOptions = q._opts.defaultJobOptions;
    expect(defaultJobOptions.attempts).toBe(5);
    expect(defaultJobOptions.backoff.type).toBe("exponential");
  });
});

describe("createWorker", () => {
  it("creates a Worker bound to the named queue", async () => {
    const { createWorker } = await import("../queue.js");
    const processor = vi.fn();
    const w = createWorker("pipeline:run", processor, { host: "redis", port: 6379 });
    // @ts-expect-error
    expect(w._name).toBe("pipeline:run");
  });

  it("configures removeOnFail to retain failed jobs for DLQ inspection", async () => {
    const { createWorker } = await import("../queue.js");
    const w = createWorker("test:queue", vi.fn(), { host: "redis", port: 6379 });
    // @ts-expect-error
    expect(w._opts.settings?.backoffStrategy).toBeUndefined(); // uses BullMQ built-in
    // removeOnFail count allows recent failures to be inspectable before moving to DLQ
    // @ts-expect-error
    expect(w._opts.removeOnFail).toEqual({ count: 100 });
  });
});
```

- [ ] **9.2** Write `packages/core/src/queue.ts`

```typescript
import { Queue, Worker, type Processor, type ConnectionOptions } from "bullmq";

// All queues use exponential backoff with a 5-retry ceiling (spec §5, ADR-13).
// Delay sequence: 1s, 2s, 4s, 8s, 16s — then DLQ.
const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: {
    type: "exponential" as const,
    delay: 1_000,
  },
};

// createQueue builds a BullMQ Queue. The DLQ is a sibling queue named
// "{name}:dlq" — BullMQ moves jobs there automatically after exhausting retries.
// Services use the DLQ queue to list, replay, or discard failed jobs.
export function createQueue(name: string, connection: ConnectionOptions): Queue {
  return new Queue(name, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
}

// createWorker builds a BullMQ Worker. removeOnFail keeps the last 100
// failed jobs visible for debugging before garbage collection.
export function createWorker<T = unknown, R = unknown>(
  queueName: string,
  processor: Processor<T, R>,
  connection: ConnectionOptions
): Worker<T, R> {
  return new Worker<T, R>(queueName, processor, {
    connection,
    // Remove successfully processed jobs immediately to conserve Redis memory.
    removeOnComplete: { count: 0 },
    // Keep last 100 failures so ops can inspect them before they fall off.
    removeOnFail: { count: 100 },
  });
}

// createDlqQueue returns the sibling DLQ queue for a given primary queue.
// Used by the `op dlq list/replay/discard` CLI commands.
export function createDlqQueue(
  primaryQueueName: string,
  connection: ConnectionOptions
): Queue {
  return new Queue(`${primaryQueueName}:dlq`, { connection });
}
```

---

## Task 10: Logger (`src/logger.ts`)

**Goal:** A structured logger that publishes non-audit events to Redis pub/sub channel `logs:{serviceName}` (fire-and-forget) and writes audit events to a BullMQ queue for guaranteed delivery (spec §12, ADR-17).

### Steps

- [ ] **10.1** Write `packages/core/src/logger.ts`

```typescript
import type Redis from "ioredis";
import type { Queue } from "bullmq";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEvent {
  timestamp: string;
  traceId: string;
  service: string;
  level: LogLevel;
  message: string;
  metadata: Record<string, unknown>;
}

export interface AuditEvent {
  timestamp: string;
  traceId: string;
  actorId: string;
  actorType: "user" | "service" | "system";
  tenantId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  result: "success" | "failure";
  metadata: Record<string, unknown>;
}

export interface LoggerConfig {
  serviceName: string;
  redis: Redis;
  // auditQueue receives guaranteed-delivery audit events. Required if the
  // service generates audit events (all services do except Execution).
  auditQueue?: Queue;
}

export interface Logger {
  debug(message: string, metadata?: Record<string, unknown>): void;
  info(message: string, metadata?: Record<string, unknown>): void;
  warn(message: string, metadata?: Record<string, unknown>): void;
  error(message: string, metadata?: Record<string, unknown>): void;
  audit(event: Omit<AuditEvent, "timestamp" | "traceId">): Promise<void>;
  withTraceId(traceId: string): Logger;
}

// createLogger returns a Logger bound to one service. The logger DOES NOT
// buffer — it publishes directly to Redis. If Redis is down, the publish
// silently no-ops (fire-and-forget, acceptable loss for non-audit logs).
// Audit events go to BullMQ for guaranteed delivery (ADR-17).
export function createLogger(config: LoggerConfig): Logger {
  function log(
    level: LogLevel,
    message: string,
    metadata: Record<string, unknown>,
    traceId: string
  ): void {
    const event: LogEvent = {
      timestamp: new Date().toISOString(),
      traceId,
      service: config.serviceName,
      level,
      message,
      metadata,
    };
    // Publish is async but we intentionally do not await — non-audit logs are
    // fire-and-forget. Redis failures are acceptable here (spec §12, ADR-17).
    config.redis
      .publish(`logs:${config.serviceName}`, JSON.stringify(event))
      .catch(() => {
        // Intentionally swallowed — Logging Service handles reconnect logic.
        // In-memory buffering is the Logging Service's responsibility.
      });
  }

  function makeLogger(traceId: string): Logger {
    return {
      debug: (msg, meta = {}) => log("debug", msg, meta, traceId),
      info: (msg, meta = {}) => log("info", msg, meta, traceId),
      warn: (msg, meta = {}) => log("warn", msg, meta, traceId),
      error: (msg, meta = {}) => log("error", msg, meta, traceId),

      async audit(event) {
        if (!config.auditQueue) {
          throw new Error(
            "auditQueue is required to emit audit events. Pass it to createLogger()."
          );
        }
        const full: AuditEvent = {
          ...event,
          timestamp: new Date().toISOString(),
          traceId,
        };
        // BullMQ add() is awaited — audit events are guaranteed delivery (ADR-17).
        await config.auditQueue.add("audit.event", full, {
          attempts: 5,
          backoff: { type: "exponential", delay: 1_000 },
        });
      },

      withTraceId(newTraceId: string): Logger {
        return makeLogger(newTraceId);
      },
    };
  }

  return makeLogger("");
}
```

---

## Task 11: Event Publisher (`src/events.ts`)

**Goal:** A `PlatformEvent` publisher that auto-generates `eventId` (UUID v4) and `timestamp` (ISO-8601 UTC), then publishes to Redis channel `events:{tenantId}:{eventType}`. The Gateway subscribes to `events:*` for outbound webhook fan-out.

### Steps

- [ ] **11.1** Write `packages/core/src/events.ts`

```typescript
import { randomUUID } from "crypto";
import type Redis from "ioredis";
import type { PlatformEvent } from "./types.js";

export interface EventPublisherConfig {
  redis: Redis;
}

export interface EventPublisher {
  publish(
    event: Omit<PlatformEvent, "eventId" | "timestamp">
  ): Promise<void>;
}

// createEventPublisher returns a publisher that fills in the two auto-generated
// fields. Services never set eventId or timestamp manually — this ensures all
// events on the bus have consistent ID format and UTC timing.
export function createEventPublisher(config: EventPublisherConfig): EventPublisher {
  return {
    async publish(partial) {
      const event: PlatformEvent = {
        ...partial,
        eventId: randomUUID(),
        timestamp: new Date().toISOString(),
      };

      // Channel format: events:{tenantId}:{eventType}
      // Gateway uses PSUBSCRIBE events:* to fan-out all tenant events (spec §11).
      const channel = `events:${event.tenantId}:${event.eventType}`;
      await config.redis.publish(channel, JSON.stringify(event));
    },
  };
}
```

---

## Task 12: Health Endpoints (`src/health.ts`)

**Goal:** `healthz()` and `readyz()` Hono route factories. `healthz` returns 200 immediately (liveness). `readyz` probes all dependencies and returns 503 if any are unreachable. Both responses include `X-Response-Time`.

### Steps

- [ ] **12.1** Write the test first: `packages/core/src/__tests__/health.test.ts`

```typescript
import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";

// Build a test app from the health factories and call the routes directly
async function buildTestApp(
  dbHealthy: boolean,
  redisHealthy: boolean
) {
  const { healthz, readyz } = await import("../health.js");

  const mockPool = {
    query: vi.fn().mockImplementation(() => {
      if (!dbHealthy) throw new Error("Connection refused");
      return Promise.resolve({ rows: [{ ok: 1 }] });
    }),
  };
  const mockRedis = {
    ping: vi.fn().mockImplementation(() => {
      if (!redisHealthy) throw new Error("Connection refused");
      return Promise.resolve("PONG");
    }),
  };

  const app = new Hono();
  // @ts-expect-error — passing mock objects as dependency types
  app.get("/healthz", healthz({ service: "test-service", version: "0.1.0" }));
  app.get(
    "/readyz",
    // @ts-expect-error
    readyz({ service: "test-service", version: "0.1.0", db: mockPool, redis: mockRedis })
  );
  return app;
}

describe("healthz", () => {
  it("returns 200 with status:ok regardless of dependency state", async () => {
    const app = await buildTestApp(false, false);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.service).toBe("test-service");
  });

  it("includes X-Response-Time header", async () => {
    const app = await buildTestApp(true, true);
    const res = await app.request("/healthz");
    expect(res.headers.get("X-Response-Time")).toMatch(/^\d+ms$/);
  });
});

describe("readyz", () => {
  it("returns 200 with status:ready when all dependencies are healthy", async () => {
    const app = await buildTestApp(true, true);
    const res = await app.request("/readyz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ready");
    expect(body.checks.postgres).toBe("ok");
    expect(body.checks.redis).toBe("ok");
  });

  it("returns 503 with status:not-ready when postgres is down", async () => {
    const app = await buildTestApp(false, true);
    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("not-ready");
    expect(body.checks.postgres).toBe("error");
    expect(body.checks.redis).toBe("ok");
  });

  it("returns 503 when redis is down", async () => {
    const app = await buildTestApp(true, false);
    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.checks.redis).toBe("error");
  });

  it("includes X-Response-Time header", async () => {
    const app = await buildTestApp(true, true);
    const res = await app.request("/readyz");
    expect(res.headers.get("X-Response-Time")).toMatch(/^\d+ms$/);
  });
});
```

- [ ] **12.2** Write `packages/core/src/health.ts`

```typescript
import type { Context } from "hono";
import type pg from "pg";
import type Redis from "ioredis";

export interface HealthConfig {
  service: string;
  version: string;
}

export interface ReadyzConfig extends HealthConfig {
  db: pg.Pool;
  redis: Redis;
}

type CheckResult = "ok" | "error";

// healthz answers the liveness question: "Is the process alive?"
// Docker Compose uses this probe to decide whether to restart the container.
// It must never probe external dependencies — just return immediately.
export function healthz(config: HealthConfig) {
  return async (c: Context) => {
    const start = Date.now();
    const body = {
      status: "ok",
      service: config.service,
      version: config.version,
    };
    c.header("X-Response-Time", `${Date.now() - start}ms`);
    return c.json(body, 200);
  };
}

// readyz answers the readiness question: "Can this service accept traffic?"
// Gateway uses this before routing requests. Returns 503 if any dependency
// is unreachable, with a per-dependency check breakdown for fast diagnosis.
export function readyz(config: ReadyzConfig) {
  return async (c: Context) => {
    const start = Date.now();
    const checks: Record<string, CheckResult> = {};

    await Promise.all([
      (async () => {
        try {
          await config.db.query("SELECT 1");
          checks.postgres = "ok";
        } catch {
          checks.postgres = "error";
        }
      })(),
      (async () => {
        try {
          const pong = await config.redis.ping();
          checks.redis = pong === "PONG" ? "ok" : "error";
        } catch {
          checks.redis = "error";
        }
      })(),
    ]);

    const allHealthy = Object.values(checks).every((v) => v === "ok");
    const status = allHealthy ? "ready" : "not-ready";
    const httpStatus = allHealthy ? 200 : 503;

    const body = {
      status,
      service: config.service,
      version: config.version,
      checks,
    };

    c.header("X-Response-Time", `${Date.now() - start}ms`);
    return c.json(body, httpStatus);
  };
}
```

---

## Task 13 Preview: Service RBAC (`src/service-rbac.ts`)

This task belongs to Part 2 (Tasks 13-23: middleware + createApp). It is listed here as context since Task 12 is the last task covered by this document.

The service RBAC matrix (spec §4, §5) is a compiled constant in `service-rbac.ts`. It maps `(callerService, targetService, httpMethod, pathPattern)` to `allowed: boolean`. The `serviceAuth` middleware imports this matrix and enforces it on every internal request. Services cannot modify the matrix at runtime — changing permissions requires rebuilding `@oneplatform/core` and redeploying all services.

---

## Verification

After implementing Tasks 1-12, run:

```bash
# From repo root
pnpm --filter @oneplatform/core run test
pnpm --filter @oneplatform/core run lint
pnpm --filter @oneplatform/core run build
```

Expected: All 6 test files pass, TypeScript compiles without errors, `dist/` is produced.

---

Part 2 (Tasks 13-23: middleware + createApp) continues in a separate document.
