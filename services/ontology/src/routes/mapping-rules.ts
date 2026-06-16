import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { ValidationError, ForbiddenError, NotFoundError } from "@oneplatform/core";
import type { MappingRuleRepository } from "../repositories/mapping-rule-repository.js";
import type { MappingErrorRepository } from "../repositories/mapping-error-repository.js";
import type { EntityRepository } from "../repositories/entity-repository.js";
import { createMappingRuleRequest, updateMappingRuleRequest } from "../schemas/index.js";

export interface MappingRuleRouteDeps {
  mappingRuleRepo: MappingRuleRepository;
  mappingErrorRepo: MappingErrorRepository;
  entityRepo: EntityRepository;
}

const REQUIRED_READ_SCOPE = "ontology:read";
const REQUIRED_WRITE_SCOPE = "ontology:write";

export function createMappingRuleRoutes(deps: MappingRuleRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { mappingRuleRepo, mappingErrorRepo, entityRepo } = deps;

  routes.get("/api/v1/ontology/:entityType/mappings", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(REQUIRED_READ_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("ontology:read scope is required.");
    }

    const entity = await entityRepo.findBySlug(user.tenantId, c.req.param("entityType"));
    if (!entity) throw new NotFoundError("Entity not found.");

    const rules = await mappingRuleRepo.findByEntityId(entity.id);
    return c.json({
      data: rules.map((r) => ({
        id: r.id,
        connectorId: r.connector_id,
        sourceFieldPath: r.source_field_path,
        targetEntityId: r.target_entity_id,
        targetFieldId: r.target_field_id,
        transformType: r.transform_type,
        transform: r.transform,
        isActive: r.is_active,
        priority: r.priority,
        createdAt: r.created_at.toISOString(),
      })),
    });
  });

  routes.post("/api/v1/ontology/:entityType/mappings", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(REQUIRED_WRITE_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("ontology:write scope is required.");
    }

    const entity = await entityRepo.findBySlug(user.tenantId, c.req.param("entityType"));
    if (!entity) throw new NotFoundError("Entity not found.");

    const body = await c.req.json();
    const parsed = createMappingRuleRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid mapping rule request", parsed.error.issues);
    }

    const rule = await mappingRuleRepo.create({
      tenant_id: user.tenantId,
      connector_id: parsed.data.connectorId,
      source_field_path: parsed.data.sourceFieldPath,
      target_entity_id: entity.id,
      target_field_id: parsed.data.targetFieldId,
      ...(parsed.data.transformType !== "direct" ? { transform_type: parsed.data.transformType } : {}),
      ...(parsed.data.transform ? { transform: parsed.data.transform } : {}),
      ...(parsed.data.priority > 0 ? { priority: parsed.data.priority } : {}),
    });

    return c.json({
      id: rule.id,
      connectorId: rule.connector_id,
      sourceFieldPath: rule.source_field_path,
      transformType: rule.transform_type,
      transform: rule.transform,
      priority: rule.priority,
      createdAt: rule.created_at.toISOString(),
    }, 201);
  });

  routes.patch("/api/v1/ontology/:entityType/mappings/:ruleId", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(REQUIRED_WRITE_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("ontology:write scope is required.");
    }

    // Tenant isolation: verify the rule belongs to this tenant before updating.
    const existingRule = await mappingRuleRepo.findById(c.req.param("ruleId"));
    if (!existingRule) throw new NotFoundError("Mapping rule not found.");
    if (existingRule.tenant_id !== user.tenantId) {
      throw new ForbiddenError("You do not have access to this mapping rule.");
    }

    const body = await c.req.json();
    const parsed = updateMappingRuleRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid mapping rule update", parsed.error.issues);
    }

    const updateData: Record<string, unknown> = {};
    if (parsed.data.sourceFieldPath) updateData["source_field_path"] = parsed.data.sourceFieldPath;
    if (parsed.data.transformType) updateData["transform_type"] = parsed.data.transformType;
    if (parsed.data.transform !== undefined) updateData["transform"] = parsed.data.transform;
    if (parsed.data.isActive !== undefined) updateData["is_active"] = parsed.data.isActive;
    if (parsed.data.priority !== undefined) updateData["priority"] = parsed.data.priority;

    const updated = await mappingRuleRepo.update(c.req.param("ruleId"), updateData as Parameters<typeof mappingRuleRepo.update>[1]);

    if (!updated) throw new NotFoundError("Mapping rule not found.");

    return c.json({
      id: updated.id,
      sourceFieldPath: updated.source_field_path,
      transformType: updated.transform_type,
      transform: updated.transform,
      isActive: updated.is_active,
      priority: updated.priority,
    });
  });

  routes.delete("/api/v1/ontology/:entityType/mappings/:ruleId", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(REQUIRED_WRITE_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("ontology:write scope is required.");
    }

    // Tenant isolation: verify the rule belongs to this tenant before deleting.
    const ruleToDelete = await mappingRuleRepo.findById(c.req.param("ruleId"));
    if (!ruleToDelete) throw new NotFoundError("Mapping rule not found.");
    if (ruleToDelete.tenant_id !== user.tenantId) {
      throw new ForbiddenError("You do not have access to this mapping rule.");
    }

    const deleted = await mappingRuleRepo.delete(c.req.param("ruleId"));
    if (!deleted) throw new NotFoundError("Mapping rule not found.");

    return new Response(null, { status: 204 });
  });

  // Returns recent mapping errors scoped to a specific rule. Errors are stored
  // per-connector in the mapping_errors table, so we look up the rule first to
  // get its connector_id and then return errors for that connector.
  // Cursor-based pagination uses the error ID (descending by created_at).
  routes.get("/api/v1/ontology/mappings/:id/errors", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(REQUIRED_READ_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("ontology:read scope is required.");
    }

    const rule = await mappingRuleRepo.findById(c.req.param("id"));
    if (!rule) throw new NotFoundError("Mapping rule not found.");

    // Tenant isolation: the rule must belong to the requesting tenant.
    if (rule.tenant_id !== user.tenantId) {
      throw new ForbiddenError("You do not have access to this mapping rule.");
    }

    const rawLimit = c.req.query("limit");
    const limit = rawLimit !== undefined ? Math.min(parseInt(rawLimit, 10) || 50, 200) : 50;
    const cursor = c.req.query("cursor");

    const errors = await mappingErrorRepo.findByConnectorId(rule.connector_id, cursor, limit);

    return c.json({
      data: errors.map((e) => ({
        id: e.id,
        connectorId: e.connector_id,
        batchId: e.batch_id,
        rawId: e.raw_id,
        entityType: e.entity_type,
        errorFields: e.error_fields,
        errorDetails: e.error_details,
        createdAt: e.created_at.toISOString(),
      })),
      pagination: {
        nextCursor: errors.length === limit ? (errors[errors.length - 1]?.id ?? null) : null,
      },
    });
  });

  return routes;
}
