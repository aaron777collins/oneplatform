import type { Logger } from "@oneplatform/core";
import type { DraftRepository } from "../repositories/draft-repository.js";
import type { InferredSchema, InferredField } from "../repositories/types.js";
import { InferInsufficientDataError } from "./errors.js";

export interface DataEnvelope {
  _id: string;
  _batchId: string;
  _connectorId: string;
  _ingestedAt: string;
  data: Record<string, unknown>;
}

export interface InferenceServiceDeps {
  logger: Logger;
  draftRepo: DraftRepository;
}

export interface InferenceService {
  inferSchema(
    tenantId: string,
    connectorId: string,
    sample: DataEnvelope[],
    entityTypeHint?: string,
  ): Promise<{ draftId: string; inferredSchema: InferredSchema }>;
}

const MIN_SAMPLE_SIZE = 10;
const MAX_DEPTH = 5;
const MAX_SAMPLE_VALUES = 3;

export function createInferenceService(deps: InferenceServiceDeps): InferenceService {
  const { logger, draftRepo } = deps;

  return {
    async inferSchema(tenantId, connectorId, sample, entityTypeHint) {
      if (sample.length < MIN_SAMPLE_SIZE) {
        throw new InferInsufficientDataError(
          `At least ${MIN_SAMPLE_SIZE} sample rows are required for inference, got ${sample.length}.`,
        );
      }

      const entityType = entityTypeHint ?? connectorId.replace(/-/g, "_");

      const pathStats = new Map<string, {
        values: unknown[];
        nullCount: number;
        totalCount: number;
      }>();

      for (const envelope of sample) {
        collectPaths(envelope.data, "", 0, pathStats, sample.length);
      }

      const fields: InferredField[] = [];
      for (const [path, stats] of pathStats) {
        const inferredType = inferType(stats.values);
        const confidence = stats.values.length > 0
          ? stats.values.filter((v) => matchesType(v, inferredType)).length / stats.values.length
          : 0;

        fields.push({
          path,
          suggestedSlug: pathToSlug(path),
          inferredType,
          confidence,
          sampleValues: stats.values.slice(0, MAX_SAMPLE_VALUES),
          nullRate: stats.totalCount > 0 ? stats.nullCount / stats.totalCount : 0,
        });
      }

      fields.sort((a, b) => b.confidence - a.confidence);

      const inferredSchema: InferredSchema = {
        entityType,
        fields,
        sampleCount: sample.length,
      };

      const draft = await draftRepo.create({
        tenant_id: tenantId,
        connector_id: connectorId,
        inferred_schema: inferredSchema,
        sample_batch_id: sample[0]?._batchId ?? "unknown",
      });

      logger.info(`Inferred schema for connector ${connectorId}: ${fields.length} fields from ${sample.length} samples`);

      return { draftId: draft.id, inferredSchema };
    },
  };
}

function collectPaths(
  obj: Record<string, unknown>,
  prefix: string,
  depth: number,
  stats: Map<string, { values: unknown[]; nullCount: number; totalCount: number }>,
  sampleSize: number,
): void {
  if (depth >= MAX_DEPTH) return;

  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;

    if (!stats.has(path)) {
      stats.set(path, { values: [], nullCount: 0, totalCount: 0 });
    }
    const entry = stats.get(path)!;
    entry.totalCount++;

    if (value === null || value === undefined) {
      entry.nullCount++;
      continue;
    }

    if (typeof value === "object" && !Array.isArray(value)) {
      collectPaths(value as Record<string, unknown>, path, depth + 1, stats, sampleSize);
    } else {
      entry.values.push(value);
    }
  }
}

function inferType(values: unknown[]): string {
  if (values.length === 0) return "string";

  const nonNull = values.filter((v) => v !== null && v !== undefined);
  if (nonNull.length === 0) return "string";

  if (nonNull.every((v) => typeof v === "boolean")) return "boolean";
  if (nonNull.every((v) => typeof v === "number" || (typeof v === "string" && !isNaN(Number(v)) && v.trim() !== ""))) return "number";
  if (nonNull.every((v) => typeof v === "string" && isIso8601(v as string))) return "date";
  if (nonNull.every((v) => Array.isArray(v))) return "array";
  if (nonNull.every((v) => typeof v === "object" && !Array.isArray(v))) return "json";

  return "string";
}

function matchesType(value: unknown, expectedType: string): boolean {
  if (value === null || value === undefined) return true;

  switch (expectedType) {
    case "boolean": return typeof value === "boolean";
    case "number": return typeof value === "number" || (typeof value === "string" && !isNaN(Number(value)));
    case "date": return typeof value === "string" && isIso8601(value);
    case "array": return Array.isArray(value);
    case "json": return typeof value === "object" && !Array.isArray(value);
    case "string": return typeof value === "string";
    default: return true;
  }
}

function isIso8601(s: string): boolean {
  if (s.length < 10) return false;
  const d = new Date(s);
  return !isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(s);
}

function pathToSlug(path: string): string {
  return path
    .replace(/\./g, "_")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .replace(/^_+/, "")
    .replace(/_+$/g, "");
}
