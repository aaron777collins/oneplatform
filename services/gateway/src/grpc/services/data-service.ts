/**
 * DataService gRPC implementation.
 *
 * Delegates to the REST service layer (ingestion service via proxy HTTP calls)
 * rather than duplicating business logic. The gRPC layer is a transport
 * adapter — the existing REST endpoints own the domain rules.
 *
 * WHY delegate to HTTP instead of calling ingestion internals directly:
 *   The ingestion service is a separate microservice. Coupling the gateway to
 *   ingestion internals would make them a distributed monolith. HTTP
 *   delegation keeps service boundaries clean and lets each service scale and
 *   deploy independently.
 */

import type {
  Entity,
  GetEntityRequest,
  ListEntitiesRequest,
  ListEntitiesResponse,
  CreateEntityRequest,
  UpdateEntityRequest,
  DeleteEntityRequest,
  DeleteEntityResponse,
  StreamEntitiesRequest,
  IngestRecord,
  BulkIngestResponse,
  IngestError,
} from "@oneplatform/sdk/grpc-types";
import type { DataServiceImpl } from "@oneplatform/sdk/grpc-types";
import { UnauthorizedError, NotFoundError } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Dependency injection interface — keeps the implementation testable without
// a live ingestion service.
// ---------------------------------------------------------------------------

export interface DataServiceDeps {
  /** Base URL of the ingestion service. */
  readonly ingestionServiceUrl: string;
  /** Bearer token for service-to-service authentication. */
  readonly serviceToken?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildHeaders(serviceToken: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (serviceToken !== undefined) {
    headers["x-service-token"] = serviceToken;
  }
  return headers;
}

async function expectJson<T>(response: Response, context: string): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    const message =
      typeof body["message"] === "string"
        ? body["message"]
        : `ingestion service returned HTTP ${response.status}`;

    if (response.status === 401 || response.status === 403) {
      throw new UnauthorizedError(message);
    }
    if (response.status === 404) {
      throw new NotFoundError(message);
    }
    throw new Error(`[${context}] ${message}`);
  }

  const json = await response.json() as { data?: T } | T;
  // Unwrap the REST { data: T } envelope if present
  if (json !== null && typeof json === "object" && "data" in json) {
    return (json as { data: T }).data;
  }
  return json as T;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDataService(deps: DataServiceDeps): DataServiceImpl {
  const { ingestionServiceUrl, serviceToken } = deps;
  const headers = buildHeaders(serviceToken);

  async function GetEntity(request: GetEntityRequest): Promise<Entity> {
    if (!request.entityType || !request.id || !request.tenantId) {
      throw new Error("GetEntity: entityType, id, and tenantId are required");
    }

    const url = `${ingestionServiceUrl}/api/v1/data/${encodeURIComponent(request.entityType)}/${encodeURIComponent(request.id)}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        ...headers,
        "x-oneplatform-tenant-id": request.tenantId,
      },
    });

    return expectJson<Entity>(response, "GetEntity");
  }

  async function ListEntities(
    request: ListEntitiesRequest,
  ): Promise<ListEntitiesResponse> {
    if (!request.entityType || !request.tenantId) {
      throw new Error("ListEntities: entityType and tenantId are required");
    }

    const params = new URLSearchParams();
    if (request.pageSize > 0) params.set("pageSize", String(request.pageSize));
    if (request.pageCursor) params.set("cursor", request.pageCursor);
    if (request.filterJson) params.set("filter", request.filterJson);

    const url = `${ingestionServiceUrl}/api/v1/data/${encodeURIComponent(request.entityType)}?${params.toString()}`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        ...headers,
        "x-oneplatform-tenant-id": request.tenantId,
      },
    });

    return expectJson<ListEntitiesResponse>(response, "ListEntities");
  }

  async function CreateEntity(request: CreateEntityRequest): Promise<Entity> {
    if (!request.entityType || !request.tenantId || !request.dataJson) {
      throw new Error("CreateEntity: entityType, tenantId, and dataJson are required");
    }

    let parsedData: unknown;
    try {
      parsedData = JSON.parse(request.dataJson);
    } catch {
      throw new Error("CreateEntity: dataJson must be valid JSON");
    }

    const url = `${ingestionServiceUrl}/api/v1/data/${encodeURIComponent(request.entityType)}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        "x-oneplatform-tenant-id": request.tenantId,
      },
      body: JSON.stringify(parsedData),
    });

    return expectJson<Entity>(response, "CreateEntity");
  }

  async function UpdateEntity(request: UpdateEntityRequest): Promise<Entity> {
    if (!request.entityType || !request.id || !request.tenantId || !request.dataJson) {
      throw new Error("UpdateEntity: entityType, id, tenantId, and dataJson are required");
    }

    let parsedData: unknown;
    try {
      parsedData = JSON.parse(request.dataJson);
    } catch {
      throw new Error("UpdateEntity: dataJson must be valid JSON");
    }

    const url = `${ingestionServiceUrl}/api/v1/data/${encodeURIComponent(request.entityType)}/${encodeURIComponent(request.id)}`;
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        ...headers,
        "x-oneplatform-tenant-id": request.tenantId,
      },
      body: JSON.stringify(parsedData),
    });

    return expectJson<Entity>(response, "UpdateEntity");
  }

  async function DeleteEntity(
    request: DeleteEntityRequest,
  ): Promise<DeleteEntityResponse> {
    if (!request.entityType || !request.id || !request.tenantId) {
      throw new Error("DeleteEntity: entityType, id, and tenantId are required");
    }

    const url = `${ingestionServiceUrl}/api/v1/data/${encodeURIComponent(request.entityType)}/${encodeURIComponent(request.id)}`;
    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        ...headers,
        "x-oneplatform-tenant-id": request.tenantId,
      },
    });

    if (response.status === 404) {
      throw new NotFoundError(`Entity ${request.id} not found`);
    }
    if (!response.ok) {
      throw new Error(`DeleteEntity: ingestion service returned HTTP ${response.status}`);
    }

    return { success: true, id: request.id };
  }

  async function* StreamEntities(
    request: StreamEntitiesRequest,
  ): AsyncIterable<Entity> {
    if (!request.entityType || !request.tenantId) {
      throw new Error("StreamEntities: entityType and tenantId are required");
    }

    const pageSize = 100;
    const limit = request.limit > 0 ? request.limit : Infinity;
    let cursor: string | undefined;
    let yielded = 0;

    // Paginate through the REST list endpoint, yielding entities one-by-one.
    // This converts a paginated REST resource into a streaming gRPC response
    // without requiring the ingestion service to support server-sent events.
    while (yielded < limit) {
      const params = new URLSearchParams({ pageSize: String(pageSize) });
      if (cursor !== undefined) params.set("cursor", cursor);
      if (request.filterJson) params.set("filter", request.filterJson);

      const url = `${ingestionServiceUrl}/api/v1/data/${encodeURIComponent(request.entityType)}?${params.toString()}`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          ...headers,
          "x-oneplatform-tenant-id": request.tenantId,
        },
      });

      const page = await expectJson<ListEntitiesResponse>(response, "StreamEntities");

      for (const entity of page.items) {
        if (yielded >= limit) break;
        yield entity;
        yielded++;
      }

      if (!page.nextCursor || page.items.length === 0) break;
      cursor = page.nextCursor;
    }
  }

  async function BulkIngest(
    stream: AsyncIterable<IngestRecord>,
  ): Promise<BulkIngestResponse> {
    const records: IngestRecord[] = [];
    for await (const record of stream) {
      records.push(record);
    }

    if (records.length === 0) {
      return { accepted: 0, rejected: 0, errors: [] };
    }

    // All records in a single bulk call must share the same connector and
    // tenant since the REST endpoint is scoped per-connector.
    const firstRecord = records[0];
    if (firstRecord === undefined) {
      return { accepted: 0, rejected: 0, errors: [] };
    }

    const { connectorId, tenantId } = firstRecord;
    if (!connectorId || !tenantId) {
      throw new Error("BulkIngest: each IngestRecord must include connectorId and tenantId");
    }

    const errors: IngestError[] = [];
    let accepted = 0;

    // Validate and parse all records before sending to fail fast on bad input.
    const parsedRecords: Array<{ data: unknown; externalId?: string }> = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (record === undefined) continue;
      try {
        const data = JSON.parse(record.dataJson);
        parsedRecords.push({
          data,
          ...(record.externalId ? { externalId: record.externalId } : {}),
        });
      } catch {
        errors.push({
          recordIndex: i,
          code: "INVALID_JSON",
          message: `Record at index ${i} has invalid dataJson`,
        });
      }
    }

    if (parsedRecords.length > 0) {
      const url = `${ingestionServiceUrl}/api/v1/connectors/${encodeURIComponent(connectorId)}/ingest`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          ...headers,
          "x-oneplatform-tenant-id": tenantId,
        },
        body: JSON.stringify({ records: parsedRecords }),
      });

      if (response.ok) {
        accepted = parsedRecords.length;
      } else {
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        const message =
          typeof body["message"] === "string"
            ? body["message"]
            : `ingestion service returned HTTP ${response.status}`;
        // Surface as a record-level error so partial success is possible on retry.
        for (let i = 0; i < parsedRecords.length; i++) {
          errors.push({
            recordIndex: i,
            code: "INGEST_FAILED",
            message,
          });
        }
      }
    }

    return {
      accepted,
      rejected: errors.length,
      errors,
    };
  }

  return {
    GetEntity,
    ListEntities,
    CreateEntity,
    UpdateEntity,
    DeleteEntity,
    StreamEntities,
    BulkIngest,
  };
}
