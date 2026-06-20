/**
 * IngestionService gRPC implementation.
 *
 * Delegates to the ingestion REST service for sync lifecycle operations.
 * StreamSyncEvents polls the sync progress endpoint and yields SyncEvent
 * messages — converting the REST polling pattern into a gRPC server stream
 * without requiring the ingestion service to expose a streaming endpoint.
 */

import type {
  TriggerSyncRequest,
  TriggerSyncResponse,
  GetSyncStatusRequest,
  SyncStatus,
  StreamSyncEventsRequest,
  SyncEvent,
  SyncError,
} from "@oneplatform/sdk/grpc-types";
import type { IngestionServiceImpl } from "@oneplatform/sdk/grpc-types";
import { UnauthorizedError, NotFoundError } from "@oneplatform/core";
import type { RpcContext } from "../service-registry.js";

// ---------------------------------------------------------------------------
// Shape of the SyncProgress object returned by the ingestion REST API.
// Mirrors services/ingestion/src/services/sync-service.ts SyncProgress.
// ---------------------------------------------------------------------------

interface SyncProgressResponse {
  syncJobId: string;
  connectorId: string;
  tenantId: string;
  status: "queued" | "running" | "success" | "failed" | "cancelled";
  syncMode: "full" | "incremental";
  totalBatches: number;
  completedBatches: number;
  failedBatches: number;
  totalRecords: number;
  processedRecords: number;
  startedAt: string | null;
  completedAt: string | null;
  lastBatchAt: string | null;
  errors: Array<{
    batchId: string;
    message: string;
    code: string;
    recordCount: number;
  }>;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface IngestionServiceDeps {
  readonly ingestionServiceUrl: string;
  readonly serviceToken?: string;
  /**
   * Polling interval for StreamSyncEvents when heartbeat is not supplied
   * by the caller. Defaults to 2000ms.
   */
  readonly streamPollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildHeaders(serviceToken: string | undefined): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (serviceToken !== undefined) {
    h["x-service-token"] = serviceToken;
  }
  return h;
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
  if (json !== null && typeof json === "object" && "data" in json) {
    return (json as { data: T }).data;
  }
  return json as T;
}

function progressToSyncStatus(p: SyncProgressResponse): SyncStatus {
  const errors: SyncError[] = p.errors.map((e) => ({
    batchId: e.batchId,
    message: e.message,
    code: e.code,
    recordCount: e.recordCount,
  }));

  return {
    syncJobId: p.syncJobId,
    connectorId: p.connectorId,
    tenantId: p.tenantId,
    status: p.status,
    syncMode: p.syncMode,
    totalBatches: p.totalBatches,
    completedBatches: p.completedBatches,
    failedBatches: p.failedBatches,
    totalRecords: p.totalRecords,
    processedRecords: p.processedRecords,
    startedAt: p.startedAt ?? "",
    completedAt: p.completedAt ?? "",
    lastBatchAt: p.lastBatchAt ?? "",
    errors,
  };
}

function isTerminal(status: string): boolean {
  return status === "success" || status === "failed" || status === "cancelled";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// The return type intentionally omits `IngestionServiceImpl` because handler signatures
// include the `ctx: RpcContext` second argument required by the gateway dispatcher.
// The registry registration in index.ts casts via `as unknown as Record<string, RpcHandler>`
// so the SDK interface contract is advisory, not enforced at the call site.
export function createIngestionService(deps: IngestionServiceDeps) {
  const { ingestionServiceUrl, serviceToken } = deps;
  const pollIntervalMs = deps.streamPollIntervalMs ?? 2_000;
  const headers = buildHeaders(serviceToken);

  // Verify the tenant ID in the request body matches the JWT-verified tenant.
  // This prevents a caller from accessing another tenant's sync jobs by crafting
  // a request body with a different tenantId than their authenticated identity.
  function assertTenantMatch(requestTenantId: string, ctx: RpcContext, method: string): void {
    if (requestTenantId !== ctx.tenantId) {
      throw new UnauthorizedError(
        `${method}: request tenantId does not match authenticated identity`,
      );
    }
  }

  async function TriggerSync(
    request: TriggerSyncRequest,
    ctx: RpcContext,
  ): Promise<TriggerSyncResponse> {
    if (!request.connectorId || !request.tenantId) {
      throw new Error("TriggerSync: connectorId and tenantId are required");
    }
    assertTenantMatch(request.tenantId, ctx, "TriggerSync");

    const url = `${ingestionServiceUrl}/api/v1/connectors/${encodeURIComponent(request.connectorId)}/sync`;
    const body: Record<string, unknown> = {};
    if (request.syncMode) body["mode"] = request.syncMode;
    if (request.force) body["force"] = true;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        "x-oneplatform-tenant-id": request.tenantId,
      },
      body: JSON.stringify(body),
    });

    const result = await expectJson<{
      syncJobId: string;
      status: string;
      estimatedStartMs: number;
    }>(response, "TriggerSync");

    return {
      syncJobId: result.syncJobId,
      status: result.status,
      estimatedStartMs: result.estimatedStartMs,
    };
  }

  async function GetSyncStatus(
    request: GetSyncStatusRequest,
    _ctx: RpcContext,
  ): Promise<SyncStatus> {
    if (!request.syncJobId) {
      throw new Error("GetSyncStatus: syncJobId is required");
    }
    // GetSyncStatus is keyed by syncJobId (not tenantId), so we can't enforce
    // tenant isolation here without a lookup. The ingestion service enforces
    // tenant ownership on its side via its own auth middleware.

    const url = `${ingestionServiceUrl}/api/v1/connectors/sync/${encodeURIComponent(request.syncJobId)}/progress`;
    const response = await fetch(url, {
      method: "GET",
      headers,
    });

    const progress = await expectJson<SyncProgressResponse>(response, "GetSyncStatus");
    return progressToSyncStatus(progress);
  }

  async function* StreamSyncEvents(
    request: StreamSyncEventsRequest,
    _ctx: RpcContext,
  ): AsyncIterable<SyncEvent> {
    if (!request.syncJobId) {
      throw new Error("StreamSyncEvents: syncJobId is required");
    }
    // StreamSyncEvents is keyed by syncJobId (not tenantId). The ingestion
    // service enforces tenant ownership on its side via its own auth middleware.

    // Use caller-supplied heartbeat interval if provided, otherwise fall back
    // to the configured poll interval. The heartbeat doubles as the poll rate.
    const effectivePollMs =
      request.heartbeatIntervalMs > 0
        ? request.heartbeatIntervalMs
        : pollIntervalMs;

    let lastStatus: string | null = null;

    while (true) {
      const url = `${ingestionServiceUrl}/api/v1/connectors/sync/${encodeURIComponent(request.syncJobId)}/progress`;
      const response = await fetch(url, {
        method: "GET",
        headers,
      });

      // Treat 404 as terminal — the sync job may have expired from Redis.
      if (response.status === 404) {
        yield {
          eventType: "terminal",
          status: {
            syncJobId: request.syncJobId,
            connectorId: "",
            tenantId: "",
            status: "failed",
            syncMode: "",
            totalBatches: 0,
            completedBatches: 0,
            failedBatches: 0,
            totalRecords: 0,
            processedRecords: 0,
            startedAt: "",
            completedAt: "",
            lastBatchAt: "",
            errors: [
              {
                batchId: "",
                message: "sync job not found — may have expired",
                code: "NOT_FOUND",
                recordCount: 0,
              },
            ],
          },
          emittedAt: new Date().toISOString(),
        };
        return;
      }

      const progress = await expectJson<SyncProgressResponse>(response, "StreamSyncEvents");
      const syncStatus = progressToSyncStatus(progress);

      if (progress.status !== lastStatus) {
        // Emit a progress event whenever status changes.
        yield {
          eventType: isTerminal(progress.status) ? "terminal" : "progress",
          status: syncStatus,
          emittedAt: new Date().toISOString(),
        };
        lastStatus = progress.status;
      } else {
        // No change — emit a heartbeat so the client knows the stream is alive.
        yield {
          eventType: "heartbeat",
          status: syncStatus,
          emittedAt: new Date().toISOString(),
        };
      }

      if (isTerminal(progress.status)) {
        return;
      }

      await sleep(effectivePollMs);
    }
  }

  return { TriggerSync, GetSyncStatus, StreamSyncEvents };
}
