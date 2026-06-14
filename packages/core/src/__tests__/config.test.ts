import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("loadConfig", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
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
    expect(config.OP_GLOBAL_RATE_LIMIT).toBe(10000);
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

  it("throws when OP_MINIO_PASSWORD is the placeholder in production", async () => {
    // Defense-in-depth: the Zod check catches deployments that bypass
    // service-entrypoint.sh (e.g., Kubernetes, bare Node.js). See OA-1.
    setMinimalEnv();
    process.env.NODE_ENV = "production";
    process.env.OP_MINIO_PASSWORD = "CHANGE_ME_minio";
    const { loadConfig } = await import("../config.js");
    expect(() => loadConfig()).toThrow(/OP_MINIO_PASSWORD/);
  });

  it("throws when OP_MINIO_PASSWORD is empty in production", async () => {
    setMinimalEnv();
    process.env.NODE_ENV = "production";
    process.env.OP_MINIO_PASSWORD = "";
    const { loadConfig } = await import("../config.js");
    expect(() => loadConfig()).toThrow(/OP_MINIO_PASSWORD/);
  });

  it("accepts a set OP_MINIO_PASSWORD in production", async () => {
    setMinimalEnv();
    process.env.NODE_ENV = "production";
    process.env.OP_MINIO_PASSWORD = "a-strong-random-secret-value";
    const { loadConfig } = await import("../config.js");
    const config = loadConfig();
    expect(config.OP_MINIO_PASSWORD).toBe("a-strong-random-secret-value");
  });
});
