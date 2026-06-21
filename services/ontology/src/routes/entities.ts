import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { ValidationError, ForbiddenError } from "@oneplatform/core";
import type { EntityService, CreateEntityInput, PatchEntityInput } from "../services/entity-service.js";
import type { RelationshipService, CreateRelationshipInput } from "../services/relationship-service.js";
import {
  createEntityRequest,
  patchEntityRequest,
  validateRecordRequest,
  listEntitiesQuery,
  deleteEntityQuery,
  createRelationshipRequest,
} from "../schemas/index.js";
import type { FieldType } from "../utils/field-type-to-pg.js";

export interface EntityRouteDeps {
  entityService: EntityService;
  relationshipService: RelationshipService;
}

const REQUIRED_READ_SCOPE = "ontology:read";
const REQUIRED_WRITE_SCOPE = "ontology:write";

// Entity type slugs are lowercase alphanumeric with hyphens and underscores.
// Enforcing this allowlist at the route boundary prevents reflected-input in
// error messages (SA-009) — the service layer re-uses the slug value verbatim
// in NotFoundError text, which would otherwise echo arbitrary URL content.
const ENTITY_TYPE_SLUG_RE = /^[a-z0-9_-]+$/i;

function validateEntityTypeParam(entityType: string): void {
  if (!ENTITY_TYPE_SLUG_RE.test(entityType)) {
    throw new ValidationError(
      "entityType must contain only alphanumeric characters, hyphens, and underscores.",
      [],
    );
  }
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as T;
}

export function createEntityRoutes(deps: EntityRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { entityService, relationshipService } = deps;

  routes.get("/api/v1/ontology", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(REQUIRED_READ_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("ontology:read scope is required.");
    }

    const query = listEntitiesQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    const result = await entityService.listEntities(user.tenantId, query.cursor, query.limit);

    // Nest pagination fields inside `data` so the SDK transport unwraps the outer
    // envelope and the Paginator callback receives { items, nextCursor, total, hasMore }
    // directly — matching the PageFetcher<T> contract without losing cursor info.
    const items = result.data.map((e) => ({
      id: e.id,
      name: e.name,
      slug: e.slug,
      version: e.version,
      description: e.description,
      isPublic: e.isPublic,
      fieldCount: e.fields.length,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
    }));
    return c.json({
      data: {
        items,
        nextCursor: result.nextCursor,
        total: null,
        hasMore: result.nextCursor !== null,
      },
    });
  });

  routes.post("/api/v1/ontology", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(REQUIRED_WRITE_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("ontology:write scope is required.");
    }

    const body = await c.req.json();
    const parsed = createEntityRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid entity creation request", parsed.error.issues);
    }

    const input: CreateEntityInput = {
      name: parsed.data.name,
      ...(parsed.data.slug ? { slug: parsed.data.slug } : {}),
      ...(parsed.data.description ? { description: parsed.data.description } : {}),
      ...(parsed.data.isPublic !== undefined ? { isPublic: parsed.data.isPublic } : {}),
      fields: parsed.data.fields.map((f) => ({
        name: f.name,
        fieldType: f.fieldType as FieldType,
        required: f.required,
        nullable: f.nullable,
        validationRules: f.validationRules,
        isIndexed: f.isIndexed,
        isUnique: f.isUnique,
        ...(f.slug ? { slug: f.slug } : {}),
        ...(f.defaultValue !== undefined ? { defaultValue: f.defaultValue } : {}),
        ...(f.enumValues ? { enumValues: f.enumValues } : {}),
        ...(f.arrayItemType ? { arrayItemType: f.arrayItemType } : {}),
        ...(f.refEntitySlug ? { refEntitySlug: f.refEntitySlug } : {}),
      })),
    };

    const entity = await entityService.createEntity(user.tenantId, user.userId, input);
    return c.json(entity, 201);
  });

  routes.get("/api/v1/ontology/:entityType", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(REQUIRED_READ_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("ontology:read scope is required.");
    }

    const entityType = c.req.param("entityType");
    validateEntityTypeParam(entityType);
    const entity = await entityService.getEntity(user.tenantId, entityType);
    const relationships = await relationshipService.getRelationships(user.tenantId, entityType);

    return c.json({ ...entity, relationships });
  });

  routes.patch("/api/v1/ontology/:entityType", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(REQUIRED_WRITE_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("ontology:write scope is required.");
    }

    const entityType = c.req.param("entityType");
    validateEntityTypeParam(entityType);
    const body = await c.req.json();
    const parsed = patchEntityRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid entity update request", parsed.error.issues);
    }

    const input: PatchEntityInput = {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
      ...(parsed.data.isPublic !== undefined ? { isPublic: parsed.data.isPublic } : {}),
      ...(parsed.data.removeFieldSlugs ? { removeFieldSlugs: parsed.data.removeFieldSlugs } : {}),
      ...(parsed.data.renameFields ? { renameFields: parsed.data.renameFields } : {}),
      ...(parsed.data.addFields ? {
        addFields: parsed.data.addFields.map((f) => ({
          name: f.name,
          fieldType: f.fieldType as FieldType,
          required: f.required,
          nullable: f.nullable,
          validationRules: f.validationRules,
          isIndexed: f.isIndexed,
          isUnique: f.isUnique,
          ...(f.slug ? { slug: f.slug } : {}),
          ...(f.defaultValue !== undefined ? { defaultValue: f.defaultValue } : {}),
          ...(f.enumValues ? { enumValues: f.enumValues } : {}),
          ...(f.arrayItemType ? { arrayItemType: f.arrayItemType } : {}),
          ...(f.refEntitySlug ? { refEntitySlug: f.refEntitySlug } : {}),
        })),
      } : {}),
      ...(parsed.data.updateFields ? {
        updateFields: parsed.data.updateFields.map((uf) => ({
          slug: uf.slug,
          ...(uf.name !== undefined ? { name: uf.name } : {}),
          ...(uf.validationRules ? { validationRules: uf.validationRules } : {}),
          ...(uf.isIndexed !== undefined ? { isIndexed: uf.isIndexed } : {}),
          ...(uf.isUnique !== undefined ? { isUnique: uf.isUnique } : {}),
          ...(uf.defaultValue !== undefined ? { defaultValue: uf.defaultValue } : {}),
        })),
      } : {}),
    };

    const result = await entityService.patchEntity(user.tenantId, user.userId, entityType, input);

    if (result.changeType === "breaking") {
      return c.json({
        migration: result.migration,
        changeType: "breaking",
        requiresConfirmation: true,
      }, 202);
    }

    return c.json({
      entity: result.entity,
      changeType: "backward_compatible",
      appliedImmediately: true,
    });
  });

  routes.delete("/api/v1/ontology/:entityType", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(REQUIRED_WRITE_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("ontology:write scope is required.");
    }

    const entityType = c.req.param("entityType");
    validateEntityTypeParam(entityType);
    const query = deleteEntityQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams));
    await entityService.deleteEntity(user.tenantId, entityType, query.confirm);

    return new Response(null, { status: 204 });
  });

  routes.post("/api/v1/ontology/:entityType/validate", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(REQUIRED_READ_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("ontology:read scope is required.");
    }

    const entityType = c.req.param("entityType");
    validateEntityTypeParam(entityType);
    const body = await c.req.json();
    const parsed = validateRecordRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid validation request", parsed.error.issues);
    }

    const result = await entityService.validateRecord(user.tenantId, entityType, parsed.data.data);
    return c.json(result);
  });

  // DE-2: non-mutating diff preview — requires only ontology:read scope.
  routes.post("/api/v1/ontology/:entityType/diff", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(REQUIRED_READ_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("ontology:read scope is required.");
    }

    const entityType = c.req.param("entityType");
    validateEntityTypeParam(entityType);
    const body = await c.req.json();
    const parsed = patchEntityRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid diff request body", parsed.error.issues);
    }

    const input: PatchEntityInput = stripUndefined({
      name: parsed.data.name,
      description: parsed.data.description,
      isPublic: parsed.data.isPublic,
      addFields: parsed.data.addFields,
      removeFieldSlugs: parsed.data.removeFieldSlugs,
      renameFields: parsed.data.renameFields,
      updateFields: parsed.data.updateFields,
    }) as PatchEntityInput;

    const result = await entityService.diffEntity(user.tenantId, entityType, input);
    return c.json({
      changes: result.changes,
      isBreaking: result.isBreaking,
      requiresMigration: result.requiresMigration,
    });
  });

  routes.post("/api/v1/ontology/:entityType/relationships", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(REQUIRED_WRITE_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("ontology:write scope is required.");
    }

    validateEntityTypeParam(c.req.param("entityType"));
    const body = await c.req.json();
    const parsed = createRelationshipRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid relationship request", parsed.error.issues);
    }

    const relInput: CreateRelationshipInput = {
      fromEntitySlug: parsed.data.fromEntitySlug,
      toEntitySlug: parsed.data.toEntitySlug,
      relationshipType: parsed.data.relationshipType,
      fromFieldName: parsed.data.fromFieldName,
      cascadeDelete: parsed.data.cascadeDelete,
      ...(parsed.data.toFieldName ? { toFieldName: parsed.data.toFieldName } : {}),
    };

    const rel = await relationshipService.createRelationship(user.tenantId, relInput);
    return c.json(rel, 201);
  });

  return routes;
}
