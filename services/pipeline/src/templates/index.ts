// Pipeline template registry
//
// Each entry describes a pre-built pipeline definition factory.  The `build`
// function accepts caller-supplied parameters and returns a PipelineDefinition
// that is validated against PipelineDefinitionSchema before the pipeline is
// created.  Keeping metadata and the factory together here means the route
// handler does not need to know anything about individual template shapes.

import { z } from "zod";
import type { PipelineDefinition } from "../schemas/index.js";
import { syncToPostgresTemplate, type SyncToPostgresParams } from "./sync-to-postgres.js";
import { csvImportTemplate, type CsvImportParams } from "./csv-import.js";
import { dailyExportTemplate, type DailyExportParams } from "./daily-export.js";
import {
  webhookToPipelineTemplate,
  type WebhookToPipelineParams,
} from "./webhook-to-pipeline.js";

// ---------------------------------------------------------------------------
// Template parameter schemas — Zod validates caller-supplied JSON before it
// reaches the factory function, so factories receive typed, trusted inputs.
// ---------------------------------------------------------------------------

const SyncToPostgresParamsSchema = z.object({
  connectorInstanceId: z.string().uuid({
    message: "connectorInstanceId must be a valid UUID",
  }),
  entityType: z.string().min(1).max(128),
  transformerId: z.string().min(1).max(128).optional(),
  syncMode: z.enum(["full", "incremental"]).optional(),
});

const CsvImportParamsSchema = z.object({
  connectorInstanceId: z.string().uuid({
    message: "connectorInstanceId must be a valid UUID",
  }),
  entityType: z.string().min(1).max(128),
  columnMapping: z.record(z.string().min(1).max(128)).refine(
    (m) => Object.keys(m).length > 0,
    { message: "columnMapping must have at least one entry" },
  ),
  skipInvalidRows: z.boolean().optional(),
});

const DailyExportParamsSchema = z.object({
  entityType: z.string().min(1).max(128),
  destinationWebhookUrl: z
    .string()
    .url()
    .startsWith("https://", { message: "destinationWebhookUrl must use HTTPS" }),
  format: z.enum(["json", "csv"]).optional(),
  filterExpression: z.string().max(5000).optional(),
});

const WebhookToPipelineParamsSchema = z.object({
  entityType: z.string().min(1).max(128),
  transformerId: z.string().min(1).max(128),
  notificationWebhookUrl: z
    .string()
    .url()
    .startsWith("https://", { message: "notificationWebhookUrl must use HTTPS" }),
  // The top-level field in the pipeline input whose existence guards processing.
  requiredPayloadField: z.string().min(1).max(128).optional(),
});

// ---------------------------------------------------------------------------
// TemplateCategory — display grouping used by UI consumers
// ---------------------------------------------------------------------------

export type TemplateCategory = "integration" | "import" | "export" | "events";

// ---------------------------------------------------------------------------
// TemplateDescriptor — everything the list endpoint returns per template
// ---------------------------------------------------------------------------

export interface TemplateDescriptor {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  /** Lucide icon name for UI rendering */
  icon: string;
  /** JSON Schema of the params object accepted by build() */
  paramsSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// TemplateEntry — internal record combining descriptor + factory + Zod schema
//
// paramsZodSchema uses z.ZodSchema (= ZodType<unknown>) rather than the
// parameterised ZodType<P> because exactOptionalPropertyTypes makes Zod's
// inferred output type (which keeps `undefined` in unions for optional fields)
// incompatible with our Params interfaces that declare optional fields.
// The cast is safe: safeParse() is the only call site and we type the result
// correctly via the generic P in buildFromTemplate().
// ---------------------------------------------------------------------------

interface TemplateEntry<P> {
  descriptor: TemplateDescriptor;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  paramsZodSchema: z.ZodSchema<any>;
  build: (params: P) => PipelineDefinition;
}

// ---------------------------------------------------------------------------
// Registry — keyed by template ID
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REGISTRY = new Map<string, TemplateEntry<any>>();

function register<P>(entry: TemplateEntry<P>): void {
  REGISTRY.set(entry.descriptor.id, entry);
}

register<SyncToPostgresParams>({
  descriptor: {
    id: "sync-to-postgres",
    name: "Sync REST API to PostgreSQL",
    description:
      "Pulls records from a REST API connector, optionally transforms them, " +
      "and upserts them into an ontology entity type.",
    category: "integration",
    icon: "RefreshCw",
    paramsSchema: {
      type: "object",
      required: ["connectorInstanceId", "entityType"],
      properties: {
        connectorInstanceId: { type: "string", format: "uuid", description: "Connector instance UUID" },
        entityType: { type: "string", description: "Target ontology entity type" },
        transformerId: { type: "string", description: "Optional transformer plugin ID" },
        syncMode: { type: "string", enum: ["full", "incremental"], description: "Sync strategy" },
      },
    },
  },
  paramsZodSchema: SyncToPostgresParamsSchema,
  build: syncToPostgresTemplate,
});

register<CsvImportParams>({
  descriptor: {
    id: "csv-import",
    name: "Import CSV to Ontology",
    description:
      "Reads a CSV file from a connector, maps columns to ontology fields, " +
      "validates row count, and bulk-upserts records.",
    category: "import",
    icon: "FileSpreadsheet",
    paramsSchema: {
      type: "object",
      required: ["connectorInstanceId", "entityType", "columnMapping"],
      properties: {
        connectorInstanceId: { type: "string", format: "uuid", description: "Connector instance UUID" },
        entityType: { type: "string", description: "Target ontology entity type" },
        columnMapping: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Maps CSV header names to ontology field names",
        },
        skipInvalidRows: { type: "boolean", description: "Skip rows that fail column mapping" },
      },
    },
  },
  paramsZodSchema: CsvImportParamsSchema,
  build: csvImportTemplate,
});

register<DailyExportParams>({
  descriptor: {
    id: "daily-export",
    name: "Daily Data Export",
    description:
      "Queries an ontology entity type, serialises the result to JSON or CSV, " +
      "and delivers it to a destination webhook.  Designed for scheduled nightly runs.",
    category: "export",
    icon: "Download",
    paramsSchema: {
      type: "object",
      required: ["entityType", "destinationWebhookUrl"],
      properties: {
        entityType: { type: "string", description: "Ontology entity type to export" },
        destinationWebhookUrl: { type: "string", format: "uri", description: "HTTPS URL to POST the export to" },
        format: { type: "string", enum: ["json", "csv"], description: "Output format (default: json)" },
        filterExpression: { type: "string", description: "JSONata filter applied before export" },
      },
    },
  },
  paramsZodSchema: DailyExportParamsSchema,
  build: dailyExportTemplate,
});

register<WebhookToPipelineParams>({
  descriptor: {
    id: "webhook-to-pipeline",
    name: "Webhook-Triggered Processing",
    description:
      "Accepts an inbound webhook payload, validates it, then fans out across " +
      "a transform-and-upsert branch and a notification branch running in parallel.",
    category: "events",
    icon: "Webhook",
    paramsSchema: {
      type: "object",
      required: ["entityType", "transformerId", "notificationWebhookUrl"],
      properties: {
        entityType: { type: "string", description: "Ontology entity type the payload belongs to" },
        transformerId: { type: "string", description: "Transformer plugin ID for the transform branch" },
        notificationWebhookUrl: { type: "string", format: "uri", description: "HTTPS URL to notify on completion" },
        requiredPayloadField: { type: "string", description: "Pipeline input field that must exist for processing to proceed (default: payload)" },
      },
    },
  },
  paramsZodSchema: WebhookToPipelineParamsSchema,
  build: webhookToPipelineTemplate,
});

// ---------------------------------------------------------------------------
// Public API used by route handlers
// ---------------------------------------------------------------------------

/** Returns metadata for all registered templates (no factory functions exposed). */
export function listTemplates(): TemplateDescriptor[] {
  return Array.from(REGISTRY.values()).map((e) => e.descriptor);
}

export interface BuildFromTemplateResult {
  definition: PipelineDefinition;
}

export interface BuildFromTemplateError {
  code: "TEMPLATE_NOT_FOUND" | "INVALID_PARAMS";
  message: string;
  details?: z.ZodError;
}

export type BuildFromTemplateOutcome =
  | { ok: true; value: BuildFromTemplateResult }
  | { ok: false; error: BuildFromTemplateError };

/**
 * Validates params against the template's Zod schema, then calls the factory.
 * Returns a discriminated-union result — callers decide how to surface errors.
 */
export function buildFromTemplate(
  templateId: string,
  params: unknown,
): BuildFromTemplateOutcome {
  const entry = REGISTRY.get(templateId);
  if (entry === undefined) {
    return {
      ok: false,
      error: {
        code: "TEMPLATE_NOT_FOUND",
        message: `Template "${templateId}" does not exist.`,
      },
    };
  }

  const parsed = entry.paramsZodSchema.safeParse(params);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: "INVALID_PARAMS",
        message: "Template parameters failed validation.",
        details: parsed.error,
      },
    };
  }

  const definition = entry.build(parsed.data);
  return { ok: true, value: { definition } };
}
