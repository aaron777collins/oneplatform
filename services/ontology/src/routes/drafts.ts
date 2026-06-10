import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { ForbiddenError, NotFoundError } from "@oneplatform/core";
import type { DraftRepository } from "../repositories/draft-repository.js";

export interface DraftRouteDeps {
  draftRepo: DraftRepository;
}

const REQUIRED_READ_SCOPE = "ontology:read";
const REQUIRED_WRITE_SCOPE = "ontology:write";

export function createDraftRoutes(deps: DraftRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { draftRepo } = deps;

  routes.get("/api/v1/ontology/drafts", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(REQUIRED_READ_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("ontology:read scope is required.");
    }

    const drafts = await draftRepo.findByTenantId(user.tenantId);
    return c.json({
      data: drafts.map((d) => ({
        id: d.id,
        connectorId: d.connector_id,
        inferredSchema: d.inferred_schema,
        status: d.status,
        sampleBatchId: d.sample_batch_id,
        createdAt: d.created_at.toISOString(),
        updatedAt: d.updated_at.toISOString(),
      })),
    });
  });

  routes.get("/api/v1/ontology/drafts/:id", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(REQUIRED_READ_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("ontology:read scope is required.");
    }

    const draft = await draftRepo.findById(c.req.param("id"));
    if (!draft || draft.tenant_id !== user.tenantId) {
      throw new NotFoundError("Draft not found.");
    }

    return c.json({
      id: draft.id,
      connectorId: draft.connector_id,
      inferredSchema: draft.inferred_schema,
      status: draft.status,
      sampleBatchId: draft.sample_batch_id,
      createdAt: draft.created_at.toISOString(),
      updatedAt: draft.updated_at.toISOString(),
    });
  });

  routes.post("/api/v1/ontology/drafts/:id/confirm", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(REQUIRED_WRITE_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("ontology:write scope is required.");
    }

    const confirmed = await draftRepo.confirm(c.req.param("id"), user.userId);
    if (!confirmed) throw new NotFoundError("Draft not found or already processed.");

    return c.json({
      id: confirmed.id,
      status: "confirmed",
      confirmedAt: confirmed.confirmed_at?.toISOString() ?? null,
    });
  });

  routes.post("/api/v1/ontology/drafts/:id/reject", async (c) => {
    const user = c.var.user;
    if (!user.scopes.includes(REQUIRED_WRITE_SCOPE) && !user.scopes.includes("admin")) {
      throw new ForbiddenError("ontology:write scope is required.");
    }

    const rejected = await draftRepo.reject(c.req.param("id"));
    if (!rejected) throw new NotFoundError("Draft not found or already processed.");

    return c.json({ id: c.req.param("id"), status: "rejected" });
  });

  return routes;
}
