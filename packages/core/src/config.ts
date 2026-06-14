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

const configSchema = z.object({
  OP_MASTER_KEY: z.string().min(1),
  OP_JWT_SECRET: z.string().min(32),
  OP_CURSOR_SECRET: z.string().min(32),

  OP_BASE_URL: z.string().url(),
  OP_ALLOWED_ORIGINS: originsSchema.optional().default("http://localhost:3000"),
  OP_WILDCARD_DOMAIN: z.string().optional(),
  OP_GATEWAY_REPLICAS: z.coerce.number().int().positive().optional(),

  OP_DATABASE_URL: z.string().url(),
  OP_REDIS_URL: z.string().url(),

  OP_GLOBAL_RATE_LIMIT: z.coerce.number().int().positive().default(10000),

  OP_SANDBOX_POOL_SIZE: z.coerce.number().int().positive().default(5),
  OP_CONNECTOR_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(300),

  OP_INGESTION_BATCH_SIZE: z.coerce.number().int().positive().max(10000).default(1000),
  OP_LARGE_SYNC_CONCURRENCY: z.coerce.number().int().positive().default(3),

  OP_MIGRATION_TIMEOUT: z.coerce.number().int().positive().default(3600),
  OP_ONTOLOGY_POLL_INTERVAL: z.coerce.number().int().positive().default(15),

  OP_REQUIRE_EMAIL_VERIFICATION: z
    .string()
    .transform((v) => v === "true")
    .default("false"),

  OP_SMTP_HOST: z.string().optional(),
  OP_SMTP_PORT: z.coerce.number().int().optional(),
  OP_SMTP_USER: z.string().optional(),
  OP_SMTP_PASS: z.string().optional(),
  OP_SMTP_FROM: z.string().email().optional(),
  OP_SMTP_SECURE: z
    .string()
    .transform((v) => v === "true")
    .default("true"),

  OP_S3_ENDPOINT: z.string().url().optional(),
  OP_S3_ACCESS_KEY: z.string().optional(),
  OP_S3_SECRET_KEY: z.string().optional(),
  OP_S3_REGION: z.string().optional(),
  OP_MINIO_USER: z.string().default("minioadmin"),
  // Secondary validation for non-Compose deployments (Kubernetes, bare Node.js)
  // where service-entrypoint.sh does not run. The primary guard is in
  // docker/service-entrypoint.sh. See OA-1 in docs/designs/friction-fixes.md.
  OP_MINIO_PASSWORD: z.string().optional().refine(
    (v) => {
      if (process.env["NODE_ENV"] === "production" && (!v || v === "CHANGE_ME_minio")) {
        return false;
      }
      return true;
    },
    { message: "OP_MINIO_PASSWORD must be set to a non-placeholder value in production" }
  ),

  OP_WEBHOOK_ALLOW_HTTP: z
    .string()
    .transform((v) => v === "true")
    .default("false"),

  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
});

export type Config = z.infer<typeof configSchema>;

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
