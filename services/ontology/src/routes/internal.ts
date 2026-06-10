import { Hono } from "hono";
import type { AppVariables } from "@oneplatform/core";
import { ValidationError } from "@oneplatform/core";
import { serviceAuthMiddleware } from "@oneplatform/core";
import type { CacheService } from "../services/cache-service.js";
import type { MappingService } from "../services/mapping-service.js";
import type { InferenceService } from "../services/inference-service.js";
import { mapRequest, inferRequest, schemaQueryRequest } from "../schemas/index.js";

export interface InternalRouteDeps {
  cacheService: CacheService;
  mappingService: MappingService;
  inferenceService: InferenceService;
  servicePublicKeys: Record<string, string>;
}

export function createInternalRoutes(deps: InternalRouteDeps): Hono<{ Variables: AppVariables }> {
  const routes = new Hono<{ Variables: AppVariables }>();
  const { cacheService, mappingService, inferenceService, servicePublicKeys } = deps;

  routes.use("/internal/*", serviceAuthMiddleware({ servicePublicKeys, targetService: "ontology-service" }));

  routes.get("/internal/ontology/schema", async (c) => {
    const params = schemaQueryRequest.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!params.success) {
      throw new ValidationError("Invalid query parameters", params.error.issues);
    }

    const ifNoneMatch = c.req.header("If-None-Match");
    if (ifNoneMatch) {
      const snapshot = await cacheService.getSnapshotIfChanged(params.data.tenantId, ifNoneMatch);
      if (!snapshot) {
        return new Response(null, { status: 304 });
      }
      return c.json(snapshot, 200, { ETag: snapshot.etag });
    }

    const snapshot = await cacheService.getSnapshot(params.data.tenantId);
    return c.json(snapshot, 200, { ETag: snapshot.etag });
  });

  routes.post("/internal/ontology/map", async (c) => {
    const body = await c.req.json();
    const parsed = mapRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid map request", parsed.error.issues);
    }

    const result = await mappingService.mapBatch(
      parsed.data.tenantId,
      parsed.data.connectorId,
      parsed.data.batchId,
      parsed.data.records,
    );

    return c.json(result);
  });

  routes.post("/internal/ontology/infer", async (c) => {
    const body = await c.req.json();
    const parsed = inferRequest.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError("Invalid infer request", parsed.error.issues);
    }

    const result = await inferenceService.inferSchema(
      parsed.data.tenantId,
      parsed.data.connectorId,
      parsed.data.sample,
      parsed.data.entityTypeHint,
    );

    return c.json(result);
  });

  return routes;
}
