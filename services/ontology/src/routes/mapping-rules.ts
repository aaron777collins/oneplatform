import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { ValidationError, ForbiddenError, NotFoundError } from "@oneplatform/core";
import type { MappingRuleRepository } from "../repositories/mapping-rule-repository.js";
import type { EntityRepository } from "../repositories/entity-repository.js";
import { createMappingRuleRequest, updateMappingRuleRequest } from "../schemas/index.js";

export interface MappingRuleRouteDeps {
  mappingRuleRepo: MappingRuleRepository;
  entityRepo: EntityRepository;
}

const REQUIRED_READ_SCOPE = "ontology:read";
const REQUIRED_WRITE_SCOPE = "ontology:write";

export function createMappingRuleRoutes(deps: MappingRuleRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { mappingRuleRepo, entityRepo } = deps;

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

    const deleted = await mappingRuleRepo.delete(c.req.param("ruleId"));
    if (!deleted) throw new NotFoundError("Mapping rule not found.");

    return new Response(null, { status: 204 });
  });

  return routes;
}
