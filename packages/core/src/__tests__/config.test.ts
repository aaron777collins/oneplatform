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
    const { loadConfig, baseConfigSchema } = await import("../config.js");
    const config = loadConfig(baseConfigSchema);
    expect(config.OP_BASE_URL).toBe("http://localhost:3000");
  });

  it("throws with a descriptive message when OP_MASTER_KEY is missing", async () => {
    setMinimalEnv();
    delete process.env.OP_MASTER_KEY;
    const { loadConfig, baseConfigSchema } = await import("../config.js");
    expect(() => loadConfig(baseConfigSchema)).toThrow(/OP_MASTER_KEY/);
  });

  it("throws when OP_ALLOWED_ORIGINS contains a wildcard in production", async () => {
    setMinimalEnv();
    process.env.NODE_ENV = "production";
    process.env.OP_ALLOWED_ORIGINS = "*";
    const { loadConfig, baseConfigSchema } = await import("../config.js");
    expect(() => loadConfig(baseConfigSchema)).toThrow(/wildcard/i);
  });

  it("applies correct defaults for base optional vars", async () => {
    setMinimalEnv();
    const { loadConfig, baseConfigSchema } = await import("../config.js");
    const config = loadConfig(baseConfigSchema);
    expect(config.OP_ALLOWED_ORIGINS).toEqual(["https://localhost"]);
  });

  it("parses OP_ALLOWED_ORIGINS as an array", async () => {
    setMinimalEnv();
    process.env.OP_ALLOWED_ORIGINS = "http://localhost:3000,https://app.example.com";
    const { loadConfig, baseConfigSchema } = await import("../config.js");
    const config = loadConfig(baseConfigSchema);
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
    // Use gatewayConfigSchema which includes OP_MINIO_PASSWORD
    const { loadConfig, gatewayConfigSchema } = await import("../config.js");
    expect(() => loadConfig(gatewayConfigSchema)).toThrow(/OP_MINIO_PASSWORD/);
  });

  it("throws when OP_MINIO_PASSWORD is empty in production", async () => {
    setMinimalEnv();
    process.env.NODE_ENV = "production";
    process.env.OP_MINIO_PASSWORD = "";
    const { loadConfig, gatewayConfigSchema } = await import("../config.js");
    expect(() => loadConfig(gatewayConfigSchema)).toThrow(/OP_MINIO_PASSWORD/);
  });

  it("accepts a set OP_MINIO_PASSWORD in production", async () => {
    setMinimalEnv();
    process.env.NODE_ENV = "production";
    process.env.OP_MINIO_PASSWORD = "a-strong-random-secret-value";
    const { loadConfig, gatewayConfigSchema } = await import("../config.js");
    const config = loadConfig(gatewayConfigSchema);
    expect(config.OP_MINIO_PASSWORD).toBe("a-strong-random-secret-value");
  });

  // Per-service schema tests — verify that service-specific vars are validated
  // and that services do NOT fail when unrelated vars are absent.

  it("gatewayConfigSchema validates gateway-specific defaults", async () => {
    setMinimalEnv();
    const { loadConfig, gatewayConfigSchema } = await import("../config.js");
    const config = loadConfig(gatewayConfigSchema);
    expect(config.OP_GLOBAL_RATE_LIMIT).toBe(10000);
    expect(config.OP_WEBHOOK_ALLOW_HTTP).toBe(false);
  });

  it("authConfigSchema validates SMTP optional fields without requiring them", async () => {
    setMinimalEnv();
    // No OP_SMTP_* vars set — auth service should still boot fine.
    const { loadConfig, authConfigSchema } = await import("../config.js");
    const config = loadConfig(authConfigSchema);
    expect(config.OP_REQUIRE_EMAIL_VERIFICATION).toBe(false);
    expect(config.OP_SMTP_HOST).toBeUndefined();
  });

  it("ingestionConfigSchema uses correct batch size default", async () => {
    setMinimalEnv();
    const { loadConfig, ingestionConfigSchema } = await import("../config.js");
    const config = loadConfig(ingestionConfigSchema);
    expect(config.OP_INGESTION_BATCH_SIZE).toBe(1000);
    expect(config.OP_LARGE_SYNC_CONCURRENCY).toBe(3);
  });

  it("ontologyConfigSchema uses correct migration timeout default", async () => {
    setMinimalEnv();
    const { loadConfig, ontologyConfigSchema } = await import("../config.js");
    const config = loadConfig(ontologyConfigSchema);
    expect(config.OP_MIGRATION_TIMEOUT).toBe(3600);
    expect(config.OP_ONTOLOGY_POLL_INTERVAL).toBe(15);
  });

  it("executionConfigSchema uses correct sandbox pool default", async () => {
    setMinimalEnv();
    const { loadConfig, executionConfigSchema } = await import("../config.js");
    const config = loadConfig(executionConfigSchema);
    expect(config.OP_SANDBOX_POOL_SIZE).toBe(5);
    expect(config.OP_CONNECTOR_TIMEOUT_SECONDS).toBe(300);
  });

  it("loggingConfigSchema does not require SMTP vars even though authConfigSchema has them", async () => {
    setMinimalEnv();
    // Crucially: logging service should not fail if OP_SMTP_FROM is absent.
    // Before OA-6, the monolithic schema would reject all services when any
    // service-specific var was malformed, even if that service never used it.
    const { loadConfig, loggingConfigSchema } = await import("../config.js");
    // loggingConfigSchema has no SMTP fields — this must succeed with no SMTP env vars.
    expect(() => loadConfig(loggingConfigSchema)).not.toThrow();
  });

  it("pluginConfigSchema and pipelineConfigSchema load with only base vars", async () => {
    setMinimalEnv();
    const { loadConfig, pluginConfigSchema, pipelineConfigSchema } = await import("../config.js");
    expect(() => loadConfig(pluginConfigSchema)).not.toThrow();
    expect(() => loadConfig(pipelineConfigSchema)).not.toThrow();
  });
});
