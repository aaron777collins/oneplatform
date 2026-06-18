/**
 * Unit tests for the IngestionService gRPC implementation.
 *
 * Fetch is mocked so no live ingestion service is required.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createIngestionService } from "../grpc/services/ingestion-service.js";
import type {
  SyncStatus,
  TriggerSyncResponse,
} from "@oneplatform/sdk/grpc-types";

const INGESTION_URL = "http://ingestion-service:3000";

function makeSyncProgress(
  status: "queued" | "running" | "success" | "failed" | "cancelled" = "running",
) {
  return {
    syncJobId: "job-123",
    connectorId: "conn-1",
    tenantId: "t1",
    status,
    syncMode: "incremental" as const,
    totalBatches: 5,
    completedBatches: 3,
    failedBatches: 0,
    totalRecords: 1000,
    processedRecords: 600,
    startedAt: "2024-01-01T00:00:00.000Z",
    completedAt: status === "success" ? "2024-01-01T01:00:00.000Z" : null,
    lastBatchAt: "2024-01-01T00:30:00.000Z",
    errors: [],
  };
}

function mockFetch(response: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: async () => response,
    }),
  );
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// TriggerSync
// ---------------------------------------------------------------------------

describe("IngestionService.TriggerSync", () => {
  it("posts to the correct sync endpoint and returns the job ID", async () => {
    const triggerRes: TriggerSyncResponse = {
      syncJobId: "job-abc",
      status: "queued",
      estimatedStartMs: 100,
    };
    mockFetch({ data: triggerRes });

    const svc = createIngestionService({ ingestionServiceUrl: INGESTION_URL });
    const result = await svc.TriggerSync({
      connectorId: "conn-1",
      tenantId: "t1",
      syncMode: "incremental",
      force: false,
    });

    expect(result.syncJobId).toBe("job-abc");
    expect(result.status).toBe("queued");
    const [url, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/v1/connectors/conn-1/sync");
    expect(init.method).toBe("POST");
  });

  it("includes force=true in the request body when force is set", async () => {
    mockFetch({ data: { syncJobId: "j1", status: "queued", estimatedStartMs: 0 } });

    const svc = createIngestionService({ ingestionServiceUrl: INGESTION_URL });
    await svc.TriggerSync({
      connectorId: "conn-1",
      tenantId: "t1",
      syncMode: "",
      force: true,
    });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["force"]).toBe(true);
  });

  it("omits syncMode from body when not provided", async () => {
    mockFetch({ data: { syncJobId: "j2", status: "queued", estimatedStartMs: 0 } });

    const svc = createIngestionService({ ingestionServiceUrl: INGESTION_URL });
    await svc.TriggerSync({
      connectorId: "conn-1",
      tenantId: "t1",
      syncMode: "",
      force: false,
    });

    const [, init] = vi.mocked(globalThis.fetch).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["mode"]).toBeUndefined();
  });

  it("throws when connectorId is missing", async () => {
    const svc = createIngestionService({ ingestionServiceUrl: INGESTION_URL });
    await expect(
      svc.TriggerSync({ connectorId: "", tenantId: "t1", syncMode: "", force: false }),
    ).rejects.toThrow(/required/i);
  });
});

// ---------------------------------------------------------------------------
// GetSyncStatus
// ---------------------------------------------------------------------------

describe("IngestionService.GetSyncStatus", () => {
  it("fetches progress and returns a SyncStatus", async () => {
    mockFetch({ data: makeSyncProgress("running") });

    const svc = createIngestionService({ ingestionServiceUrl: INGESTION_URL });
    const status: SyncStatus = await svc.GetSyncStatus({ syncJobId: "job-123" });

    expect(status.syncJobId).toBe("job-123");
    expect(status.status).toBe("running");
    expect(status.totalBatches).toBe(5);
    expect(status.completedBatches).toBe(3);
  });

  it("throws when syncJobId is empty", async () => {
    const svc = createIngestionService({ ingestionServiceUrl: INGESTION_URL });
    await expect(svc.GetSyncStatus({ syncJobId: "" })).rejects.toThrow(/required/i);
  });

  it("maps null timestamps to empty strings", async () => {
    mockFetch({ data: makeSyncProgress("queued") });

    const svc = createIngestionService({ ingestionServiceUrl: INGESTION_URL });
    const status = await svc.GetSyncStatus({ syncJobId: "job-123" });

    // startedAt is null in the raw response for queued jobs
    expect(typeof status.completedAt).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// StreamSyncEvents
// ---------------------------------------------------------------------------

describe("IngestionService.StreamSyncEvents", () => {
  it("yields a terminal event when sync is already completed", async () => {
    mockFetch({ data: makeSyncProgress("success") });

    const svc = createIngestionService({
      ingestionServiceUrl: INGESTION_URL,
      streamPollIntervalMs: 0,
    });

    const events = [];
    for await (const event of svc.StreamSyncEvents({ syncJobId: "job-123", heartbeatIntervalMs: 0 })) {
      events.push(event);
    }

    expect(events.length).toBeGreaterThan(0);
    const lastEvent = events[events.length - 1];
    expect(lastEvent?.eventType).toBe("terminal");
    expect(lastEvent?.status.status).toBe("success");
  });

  it("yields a terminal event when the progress endpoint returns 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({}),
      }),
    );

    const svc = createIngestionService({
      ingestionServiceUrl: INGESTION_URL,
      streamPollIntervalMs: 0,
    });

    const events = [];
    for await (const event of svc.StreamSyncEvents({ syncJobId: "expired-job", heartbeatIntervalMs: 0 })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("terminal");
    expect(events[0]?.status.status).toBe("failed");
  });

  it("yields heartbeat events when status has not changed", async () => {
    // Return running twice, then success on third call
    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        callCount++;
        const status = callCount >= 3 ? "success" : "running";
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: makeSyncProgress(status as "running" | "success"),
          }),
        };
      }),
    );

    const svc = createIngestionService({
      ingestionServiceUrl: INGESTION_URL,
      streamPollIntervalMs: 0,
    });

    const events = [];
    for await (const event of svc.StreamSyncEvents({ syncJobId: "job-123", heartbeatIntervalMs: 0 })) {
      events.push(event);
    }

    // First call: progress (status changed from null to running)
    // Second call: heartbeat (running → running, no change)
    // Third call: terminal (running → success)
    const types = events.map((e) => e.eventType);
    expect(types).toContain("heartbeat");
    expect(types[types.length - 1]).toBe("terminal");
  });

  it("throws when syncJobId is empty", async () => {
    const svc = createIngestionService({ ingestionServiceUrl: INGESTION_URL });
    const gen = svc.StreamSyncEvents({ syncJobId: "", heartbeatIntervalMs: 0 });

    await expect(async () => {
      for await (const _ev of gen) { /* drain */ }
    }).rejects.toThrow(/required/i);
  });
});
