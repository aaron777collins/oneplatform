import { z } from "zod";

// originsSchema splits a comma-separated string and guards against wildcard
// in production, where a wildcard would open all cross-origin requests.
const originsSchema = z
  .string()
  .transform((val) => val.split(",").map((s) => s.trim()))
  .refine(
    (origins) => {
      if (process.env["NODE_ENV"] === "production") {
        return !origins.includes("*");
      }
      return true;
    },
    { message: "Wildcard (*) is not allowed in OP_ALLOWED_ORIGINS in production" }
  );

// Secondary validation for non-Compose deployments (Kubernetes, bare Node.js)
// where service-entrypoint.sh does not run. The primary guard is in
// docker/service-entrypoint.sh. See OA-1 in docs/designs/friction-fixes.md.
const minioPasswordSchema = z.string().optional().refine(
  (v) => {
    if (process.env["NODE_ENV"] === "production" && (!v || v === "CHANGE_ME_minio")) {
      return false;
    }
    return true;
  },
  { message: "OP_MINIO_PASSWORD must be set to a non-placeholder value in production" }
);

// ─── Base schema — every service requires these vars ──────────────────────────
// All per-service schemas extend this via .extend() so common validation is DRY.
export const baseConfigSchema = z.object({
  OP_MASTER_KEY: z.string().min(1),
  OP_JWT_SECRET: z.string().min(32),
  OP_CURSOR_SECRET: z.string().min(32),
  OP_BASE_URL: z.string().url(),
  OP_ALLOWED_ORIGINS: originsSchema.optional().default("https://localhost"),
  OP_DATABASE_URL: z.string().url(),
  OP_REDIS_URL: z.string().url(),
  // Optional OTLP endpoint — when absent, the otelMiddleware still runs but
  // span records only appear in stdout (no collector forwarding).
  // Shared by all services so traces from every layer are correlated.
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
});

// ─── Per-service schemas — extend base with service-specific vars ─────────────
// Services only fail at startup when THEIR required vars are missing, not vars
// that belong to other services. Fixes OA-6 where the logging service would
// reject a deployment that had no OP_SMTP_* vars even though it never reads them.

export const gatewayConfigSchema = baseConfigSchema.extend({
  OP_GLOBAL_RATE_LIMIT: z.coerce.number().int().positive().default(10000),
  OP_GATEWAY_REPLICAS: z.coerce.number().int().positive().optional(),
  OP_WEBHOOK_ALLOW_HTTP: z.string().transform((v) => v === "true").default("false"),
  OP_MINIO_USER: z.string().default("minioadmin"),
  OP_MINIO_PASSWORD: minioPasswordSchema,
});

export const authConfigSchema = baseConfigSchema.extend({
  OP_REQUIRE_EMAIL_VERIFICATION: z.string().transform((v) => v === "true").default("false"),
  OP_SMTP_HOST: z.string().optional(),
  OP_SMTP_PORT: z.coerce.number().int().optional(),
  OP_SMTP_USER: z.string().optional(),
  OP_SMTP_PASS: z.string().optional(),
  OP_SMTP_FROM: z.string().min(1).optional(),
  OP_SMTP_SECURE: z.string().transform((v) => v === "true").default("true"),
  OP_MINIO_USER: z.string().default("minioadmin"),
  OP_MINIO_PASSWORD: minioPasswordSchema,
  // Configurable account lockout policy (PA-018).
  // Defaults match the previous hardcoded values so existing deployments see
  // no behaviour change unless they explicitly set these vars.
  OP_LOCKOUT_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  OP_LOCKOUT_DURATION_MINUTES: z.coerce.number().int().min(1).default(30),
});

export const ingestionConfigSchema = baseConfigSchema.extend({
  OP_INGESTION_BATCH_SIZE: z.coerce.number().int().positive().max(10000).default(1000),
  OP_LARGE_SYNC_CONCURRENCY: z.coerce.number().int().positive().default(3),
  OP_MINIO_USER: z.string().default("minioadmin"),
  OP_MINIO_PASSWORD: minioPasswordSchema,
});

export const ontologyConfigSchema = baseConfigSchema.extend({
  OP_MIGRATION_TIMEOUT: z.coerce.number().int().positive().default(3600),
  OP_ONTOLOGY_POLL_INTERVAL: z.coerce.number().int().positive().default(15),
  OP_MINIO_USER: z.string().default("minioadmin"),
  OP_MINIO_PASSWORD: minioPasswordSchema,
});

export const pipelineConfigSchema = baseConfigSchema.extend({
  OP_MINIO_USER: z.string().default("minioadmin"),
  OP_MINIO_PASSWORD: minioPasswordSchema,
});

export const executionConfigSchema = baseConfigSchema.extend({
  OP_SANDBOX_POOL_SIZE: z.coerce.number().int().positive().default(5),
  OP_CONNECTOR_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),
  OP_MINIO_USER: z.string().default("minioadmin"),
  OP_MINIO_PASSWORD: minioPasswordSchema,
});

export const appConfigSchema = baseConfigSchema.extend({
  OP_WILDCARD_DOMAIN: z.string().optional(),
  OP_MINIO_USER: z.string().default("minioadmin"),
  OP_MINIO_PASSWORD: minioPasswordSchema,
});

export const loggingConfigSchema = baseConfigSchema.extend({
  OP_MINIO_USER: z.string().default("minioadmin"),
  OP_MINIO_PASSWORD: minioPasswordSchema,
  // OTEL_EXPORTER_OTLP_ENDPOINT moved to baseConfigSchema so all services
  // share the same validated config field. No need to redeclare here.
});

export const pluginConfigSchema = baseConfigSchema.extend({
  OP_MINIO_USER: z.string().default("minioadmin"),
  OP_MINIO_PASSWORD: minioPasswordSchema,
});

// ─── Derived types ────────────────────────────────────────────────────────────

export type BaseConfig = z.infer<typeof baseConfigSchema>;
export type GatewayConfig = z.infer<typeof gatewayConfigSchema>;
export type AuthConfig = z.infer<typeof authConfigSchema>;
export type IngestionConfig = z.infer<typeof ingestionConfigSchema>;
export type OntologyConfig = z.infer<typeof ontologyConfigSchema>;
export type PipelineConfig = z.infer<typeof pipelineConfigSchema>;
export type ExecutionConfig = z.infer<typeof executionConfigSchema>;
export type AppServiceConfig = z.infer<typeof appConfigSchema>;
export type LoggingConfig = z.infer<typeof loggingConfigSchema>;
export type PluginServiceConfig = z.infer<typeof pluginConfigSchema>;

// ─── Config loader ────────────────────────────────────────────────────────────

/**
 * Loads and validates environment variables against the provided service-specific schema.
 *
 * Each service passes its own schema so startup fails only when THAT service's
 * required vars are absent, not vars belonging to other services.
 *
 * @throws `Error` with a human-readable list of all validation failures when
 *   any required variable is missing or malformed. The error message is
 *   designed to be read directly from container logs.
 *
 * @example
 *   import { loadConfig, gatewayConfigSchema } from "@oneplatform/core";
 *   const config = loadConfig(gatewayConfigSchema);
 */
export function loadConfig<S extends z.ZodTypeAny>(serviceSchema: S): z.infer<S> {
  const result = serviceSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Configuration validation failed:\n${issues}`);
  }
  return result.data as z.infer<S>;
}
