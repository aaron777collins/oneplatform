import type pg from "pg";
import type { Redis } from "ioredis";
import type { Logger, ServiceTokenSigner } from "@oneplatform/core";
import type { MappingRuleRepository } from "../repositories/mapping-rule-repository.js";
import type { MappingErrorRepository } from "../repositories/mapping-error-repository.js";
import type { EntityRepository } from "../repositories/entity-repository.js";
import type { FieldRepository } from "../repositories/field-repository.js";
import type { MappingRuleRow, FieldRow } from "../repositories/types.js";
import { buildEntityZodSchema } from "./field-service.js";
import { quotePgIdentifier, tenantSchemaName } from "../utils/pg-identifier.js";
import type { DataEnvelope } from "./inference-service.js";

export interface MappingServiceDeps {
  db: pg.Pool;
  redis: Redis;
  logger: Logger;
  mappingRuleRepo: MappingRuleRepository;
  mappingErrorRepo: MappingErrorRepository;
  entityRepo: EntityRepository;
  fieldRepo: FieldRepository;
  executionServiceUrl?: string;
  serviceTokenSigner?: ServiceTokenSigner;
}

export interface MapResult {
  mapped: number;
  failed: number;
  errors: Array<{
    rawId: string;
    fields: string[];
    details: Record<string, string>;
  }>;
}

export interface MappingService {
  mapBatch(tenantId: string, connectorId: string, batchId: string, records: DataEnvelope[]): Promise<MapResult>;
}

export function createMappingService(deps: MappingServiceDeps): MappingService {
  const { db, redis, logger, mappingRuleRepo, mappingErrorRepo, entityRepo, fieldRepo, executionServiceUrl, serviceTokenSigner } = deps;

  return {
    async mapBatch(tenantId, connectorId, batchId, records) {
      const rules = await mappingRuleRepo.findByConnectorId(connectorId, true);
      if (rules.length === 0) {
        logger.warn(`No active mapping rules found for connector ${connectorId}`);
        return { mapped: 0, failed: 0, errors: [] };
      }

      // Group rules by target entity
      const rulesByEntity = new Map<string, MappingRuleRow[]>();
      for (const rule of rules) {
        const existing = rulesByEntity.get(rule.target_entity_id) ?? [];
        existing.push(rule);
        rulesByEntity.set(rule.target_entity_id, existing);
      }

      let mapped = 0;
      let failed = 0;
      const errors: MapResult["errors"] = [];

      // Simple Map caches for entity and field lookups to avoid redundant DB
      // round-trips when multiple rule groups reference the same entity.
      const entityCache = new Map<string, Awaited<ReturnType<typeof entityRepo.findById>>>();
      const fieldCache = new Map<string, FieldRow[]>();

      for (const [entityId, entityRules] of rulesByEntity) {
        let entity = entityCache.get(entityId);
        if (entity === undefined) {
          entity = await entityRepo.findById(tenantId, entityId);
          entityCache.set(entityId, entity);
        }
        if (!entity) continue;

        let fields = fieldCache.get(entityId);
        if (fields === undefined) {
          fields = await fieldRepo.findByEntityId(entityId);
          fieldCache.set(entityId, fields);
        }
        const zodSchema = buildEntityZodSchema(fields).omit({
          _id: true,
          _createdAt: true,
          _updatedAt: true,
          _version: true,
          _sourceId: true,
        });

        const schemaName = tenantSchemaName(tenantId);
        const validRecords: Array<{ sourceId: string; data: Record<string, unknown> }> = [];
        const failedRecords: Array<{ rawId: string; fields: string[]; details: Record<string, string>; rawData: Record<string, unknown> }> = [];

        for (const record of records) {
          const mappedRecord: Record<string, unknown> = {};

          // Track already-mapped field slugs so higher-priority rules (sorted
          // first) win and later rules targeting the same slug are skipped.
          const claimedSlugs = new Set<string>();

          for (const rule of entityRules) {
            const sourceValue = getNestedValue(record.data, rule.source_field_path);
            let transformedValue = sourceValue;

            if (rule.transform_type === "constant") {
              try {
                transformedValue = JSON.parse(rule.transform ?? "null");
              } catch (parseErr) {
                // The stored transform value is not valid JSON — treat it as a raw string
                // and warn so that misconfigured rules surface in logs rather than silently
                // producing unexpected output types for downstream validation.
                logger.warn(
                  `Rule ${rule.id}: constant transform value is not valid JSON ` +
                  `(transform=${JSON.stringify(rule.transform)}); using raw string. ` +
                  `Parse error: ${String(parseErr)}`,
                );
                transformedValue = rule.transform;
              }
            } else if (rule.transform_type === "template" && rule.transform) {
              transformedValue = rule.transform.replace(/\$\{value\}/g, String(sourceValue ?? ""));
            } else if (rule.transform_type === "expression" && rule.transform) {
              if (!executionServiceUrl) {
                // No Execution Service configured — expression transforms cannot run.
                // Fall back to direct mapping but surface the skip so rule authors
                // know their transform is not executing.
                logger.warn(
                  `Rule ${rule.id}: expression transform skipped because executionServiceUrl is not configured. ` +
                  `The source value will be used without transformation.`,
                );
                transformedValue = sourceValue;
              } else {
                // Default to the source value; overwritten only on a successful execution
                // response so a timeout or non-ok reply does not silently corrupt data.
                transformedValue = sourceValue;
                try {
                  // Sign every call to the internal execution endpoint.  Without
                  // the service token the execution service will reject the request
                  // with 401, so we fall back gracefully if no signer is wired.
                  const serviceToken = serviceTokenSigner ? await serviceTokenSigner.sign() : undefined;
                  const response = await fetch(`${executionServiceUrl}/internal/execution/run`, {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                      ...(serviceToken !== undefined ? { "X-Service-Token": serviceToken } : {}),
                    },
                    body: JSON.stringify({
                      tenantId,
                      type: "expression",
                      code: `(function(value, context) { return (${rule.transform}); })(value, context)`,
                      language: "js",
                      timeout: 5000,
                      context: {
                        value: sourceValue,
                        record: record.data,
                        traceId: batchId,
                        tenantId,
                      },
                    }),
                  });
                  if (response.ok) {
                    const result = await response.json() as { result: unknown };
                    transformedValue = result.result;
                  } else {
                    // A non-ok response (e.g. 504 timeout, 422 sandbox error) means
                    // the transform did not run. Log with rule ID so operators can
                    // identify which rule is failing rather than hunting through logs.
                    logger.warn(
                      `Rule ${rule.id}: expression transform returned HTTP ${response.status} — ` +
                      `falling back to source value. Check Execution Service logs for details.`,
                    );
                  }
                } catch (err) {
                  // Network error or AbortError (client-side timeout). Surface rule ID
                  // so the failure is actionable without cross-referencing connector config.
                  logger.warn(
                    `Rule ${rule.id}: expression transform failed (${String(err)}) — ` +
                    `falling back to source value.`,
                  );
                }
              }
            }

            // Find target field slug — skip if already claimed by a higher-priority rule
            const targetField = fields.find((f) => f.id === rule.target_field_id);
            if (targetField) {
              if (claimedSlugs.has(targetField.slug)) continue;
              mappedRecord[targetField.slug] = transformedValue;
              claimedSlugs.add(targetField.slug);
            }
          }

          const validation = zodSchema.safeParse(mappedRecord);
          if (validation.success) {
            validRecords.push({ sourceId: record._id, data: validation.data as Record<string, unknown> });
          } else {
            const errFields: string[] = [];
            const errDetails: Record<string, string> = {};
            for (const issue of validation.error.issues) {
              const fieldName = issue.path.join(".");
              errFields.push(fieldName);
              errDetails[fieldName] = issue.message;
            }
            failedRecords.push({ rawId: record._id, fields: errFields, details: errDetails, rawData: record.data });
          }
        }

        // Upsert valid records — batch by column set to use multi-row INSERT
        if (validRecords.length > 0) {
          const table = `${quotePgIdentifier(schemaName)}.${quotePgIdentifier(entity.slug)}`;
          const userFieldSlugs = fields.filter((f) => !f.system_generated).map((f) => f.slug);

          // Group records by their column set so each group can be inserted
          // with a single multi-row INSERT statement instead of one per record.
          const groupsByColKey = new Map<string, {
            cols: string[];
            records: Array<{ sourceId: string; data: Record<string, unknown> }>;
          }>();

          for (const rec of validRecords) {
            const cols = ["_source_id", ...userFieldSlugs.filter((s) => rec.data[s] !== undefined)];
            const colKey = cols.join(",");
            let group = groupsByColKey.get(colKey);
            if (!group) {
              group = { cols, records: [] };
              groupsByColKey.set(colKey, group);
            }
            group.records.push(rec);
          }

          const client = await db.connect();
          try {
            await client.query("BEGIN");

            for (const { cols, records: groupRecords } of groupsByColKey.values()) {
              const colNames = cols.map((c) => quotePgIdentifier(c));
              const updateSets = cols.slice(1).map((c) => `${quotePgIdentifier(c)} = EXCLUDED.${quotePgIdentifier(c)}`);

              // Build multi-row VALUES clause
              const allVals: unknown[] = [];
              const rowPlaceholders: string[] = [];
              for (const rec of groupRecords) {
                const vals = [rec.sourceId, ...userFieldSlugs.filter((s) => rec.data[s] !== undefined).map((s) => rec.data[s])];
                const offset = allVals.length;
                const ph = vals.map((_, i) => `$${offset + i + 1}`);
                rowPlaceholders.push(`(${ph.join(", ")})`);
                allVals.push(...vals);
              }

              await client.query(
                `INSERT INTO ${table} (${colNames.join(", ")})
                 VALUES ${rowPlaceholders.join(", ")}
                 ON CONFLICT ("_source_id") DO UPDATE SET ${updateSets.join(", ")}, "_updated_at" = now(), "_version" = ${table}."_version" + 1`,
                allVals,
              );
            }

            await client.query("COMMIT");
            mapped += validRecords.length;
          } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            logger.error(`Mapping upsert failed: ${String(err)}`);
            throw err;
          } finally {
            client.release();
          }
        }

        // Record failures
        if (failedRecords.length > 0) {
          await mappingErrorRepo.createMany(
            failedRecords.map((f) => ({
              tenant_id: tenantId,
              connector_id: connectorId,
              batch_id: batchId,
              raw_id: f.rawId,
              entity_type: entity.slug,
              error_fields: f.fields,
              error_details: f.details,
              raw_data: f.rawData,
            })),
          );
          failed += failedRecords.length;
          errors.push(...failedRecords.map((f) => ({
            rawId: f.rawId,
            fields: f.fields,
            details: f.details,
          })));
        }
      }

      logger.info(`Mapped batch ${batchId}: ${mapped} success, ${failed} failed`);
      return { mapped, failed, errors };
    },
  };
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
