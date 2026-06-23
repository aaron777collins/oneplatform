// Unit tests for GdprService.
//
// All external I/O (downstream HTTP calls, repository, logger) is mocked so
// tests run without a real database or network.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGdprService } from "../services/gdpr-service.js";
import type { GdprServiceDeps } from "../services/gdpr-service.js";
import type { GdprRequestRow } from "../repositories/types.js";
import { ForbiddenError, NotFoundError } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<GdprRequestRow> = {}): GdprRequestRow {
  return {
    id: "req-0001",
    tenant_id: "tenant-1",
    user_id: "user-1",
    type: "access",
    status: "pending",
    requester_id: "user-1",
    requested_at: new Date("2024-01-01T00:00:00Z"),
    completed_at: null,
    result_url: null,
    error_detail: null,
    ...overrides,
  };
}

function makeLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    audit: vi.fn().mockResolvedValue(undefined),
    withTraceId: vi.fn().mockReturnThis(),
  };
}

function makeDeps(
  repoOverrides: Partial<GdprServiceDeps["gdprRequestRepo"]> = {},
): GdprServiceDeps {
  const repo = {
    create: vi.fn().mockResolvedValue(makeRow()),
    findById: vi.fn().mockResolvedValue(makeRow()),
    findByTenantId: vi.fn().mockResolvedValue([makeRow()]),
    updateStatus: vi.fn().mockResolvedValue(makeRow()),
    ...repoOverrides,
  };

  const storageService = {
    putObject: vi.fn().mockResolvedValue(undefined),
    generatePresignedDownloadUrl: vi
      .fn()
      .mockResolvedValue({ url: "https://storage.example/download" }),
  };

  return {
    gdprRequestRepo: repo as never,
    logger: makeLogger() as never,
    storageService: storageService as never,
    config: {
      authServiceUrl: "http://auth",
      loggingServiceUrl: "http://logging",
      ingestionServiceUrl: "http://ingestion",
      appServiceUrl: "http://app",
      serviceTokenSigner: { sign: async () => "svc-token" },
    },
  };
}

// ---------------------------------------------------------------------------
// createRequest()
// ---------------------------------------------------------------------------

describe("GdprService.createRequest()", () => {
  it("creates a repository row and emits an audit event", async () => {
    const deps = makeDeps();
    const svc = createGdprService(deps);

    const row = await svc.createRequest("access", "user-1", "tenant-1", "user-1");

    expect(deps.gdprRequestRepo.create).toHaveBeenCalledWith({
      tenant_id: "tenant-1",
      user_id: "user-1",
      type: "access",
      requester_id: "user-1",
    });
    expect(deps.logger.audit).toHaveBeenCalledOnce();
    expect(row.id).toBe("req-0001");
  });

  it("records the requesterId separately from userId for admin-on-behalf-of flows", async () => {
    const deps = makeDeps();
    const svc = createGdprService(deps);

    await svc.createRequest("deletion", "target-user", "tenant-1", "admin-user");

    expect(deps.gdprRequestRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: "target-user",
        requester_id: "admin-user",
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// getRequest()
// ---------------------------------------------------------------------------

describe("GdprService.getRequest()", () => {
  it("returns the row when tenant matches", async () => {
    const row = makeRow();
    const deps = makeDeps({ findById: vi.fn().mockResolvedValue(row) });
    const svc = createGdprService(deps);

    const result = await svc.getRequest("req-0001", "tenant-1");
    expect(result).toBe(row);
  });

  it("throws NotFoundError when the row does not exist", async () => {
    const deps = makeDeps({ findById: vi.fn().mockResolvedValue(null) });
    const svc = createGdprService(deps);

    await expect(svc.getRequest("nonexistent", "tenant-1")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("throws ForbiddenError on tenant mismatch (prevents cross-tenant access)", async () => {
    const row = makeRow({ tenant_id: "tenant-OTHER" });
    const deps = makeDeps({ findById: vi.fn().mockResolvedValue(row) });
    const svc = createGdprService(deps);

    await expect(svc.getRequest("req-0001", "tenant-1")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

// ---------------------------------------------------------------------------
// listRequests()
// ---------------------------------------------------------------------------

describe("GdprService.listRequests()", () => {
  it("delegates to repository with all options", async () => {
    const deps = makeDeps();
    const svc = createGdprService(deps);

    await svc.listRequests("tenant-1", { userId: "u", status: "completed", cursor: "c", limit: 10 });

    expect(deps.gdprRequestRepo.findByTenantId).toHaveBeenCalledWith("tenant-1", {
      userId: "u",
      status: "completed",
      cursor: "c",
      limit: 10,
    });
  });
});

// ---------------------------------------------------------------------------
// handleAccessRequest()
// ---------------------------------------------------------------------------

describe("GdprService.handleAccessRequest()", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("marks the request processing then completed on success", async () => {
    const deps = makeDeps();
    const svc = createGdprService(deps);

    // Stub global fetch to return success for both downstream calls
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: {} }),
        text: vi.fn().mockResolvedValue(""),
      }),
    );

    await svc.handleAccessRequest("req-0001", "user-1", "tenant-1");

    const updateCalls = (deps.gdprRequestRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls as Array<[string, { status: string }]>;
    expect(updateCalls.at(0)?.[1]).toMatchObject({ status: "processing" });
    expect(updateCalls.at(1)?.[1]).toMatchObject({ status: "completed" });
    // handleAccessRequest emits one audit event on completion
    // (the creation audit is emitted by createRequest, called separately)
    expect(deps.logger.audit).toHaveBeenCalledOnce();
  });

  it("marks the request failed and rethrows when a downstream call fails", async () => {
    const deps = makeDeps();
    const svc = createGdprService(deps);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: vi.fn().mockResolvedValue("Service unavailable"),
        json: vi.fn().mockResolvedValue({}),
      }),
    );

    await expect(
      svc.handleAccessRequest("req-0001", "user-1", "tenant-1"),
    ).rejects.toThrow();

    const updateCalls = (deps.gdprRequestRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls as Array<[string, { status: string; error_detail?: string }]>;
    const lastCall = updateCalls.at(-1);
    expect(lastCall?.[1]).toMatchObject({ status: "failed" });
    expect(lastCall?.[1].error_detail).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// handleDeletionRequest()
// ---------------------------------------------------------------------------

describe("GdprService.handleDeletionRequest()", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("fans out to all 4 downstream services and marks completed", async () => {
    const deps = makeDeps();
    const svc = createGdprService(deps);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({}),
      text: vi.fn().mockResolvedValue(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    await svc.handleDeletionRequest("req-0001", "user-1", "tenant-1");

    // Should have called 4 downstream services: auth, logging, ingestion, app
    expect(fetchMock).toHaveBeenCalledTimes(4);

    const urls = fetchMock.mock.calls.map(
      (call: [string, unknown]) => call[0],
    );
    expect(urls.some((u: string) => u.includes("/internal/gdpr/users/") && u.includes("anonymise"))).toBe(true);
    expect(urls.some((u: string) => u.includes("/internal/gdpr/audit-log"))).toBe(true);
    expect(urls.some((u: string) => u.includes("/internal/gdpr/connectors"))).toBe(true);
    expect(urls.some((u: string) => u.includes("/internal/gdpr/apps"))).toBe(true);

    const updateCalls = (deps.gdprRequestRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls as Array<[string, { status: string }]>;
    const lastStatus = updateCalls.at(-1)?.[1].status;
    expect(lastStatus).toBe("completed");
  });

  it("marks the request failed if any downstream service fails, still attempts all services", async () => {
    const deps = makeDeps();
    const svc = createGdprService(deps);

    let callCount = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        callCount++;
        // Fail the first call (auth), succeed the rest
        if (callCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 500,
            text: () => Promise.resolve("Internal error"),
            json: () => Promise.resolve({}),
          });
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve(""),
        });
      }),
    );

    await expect(
      svc.handleDeletionRequest("req-0001", "user-1", "tenant-1"),
    ).rejects.toThrow("GDPR deletion completed with errors");

    // All 4 services must have been attempted even though the first failed
    expect(callCount).toBe(4);

    const updateCalls = (deps.gdprRequestRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls as Array<[string, { status: string; error_detail?: string }]>;
    const lastCall = updateCalls.at(-1);
    expect(lastCall?.[1].status).toBe("failed");
    expect(lastCall?.[1].error_detail).toContain("auth:");
  });

  it("attaches X-Service-Token header to all downstream calls", async () => {
    const deps = makeDeps();
    const svc = createGdprService(deps);

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({}),
      text: vi.fn().mockResolvedValue(""),
    });
    vi.stubGlobal("fetch", fetchMock);

    await svc.handleDeletionRequest("req-0001", "user-1", "tenant-1");

    for (const call of fetchMock.mock.calls as [string, RequestInit][]) {
      const headers = call[1].headers as Record<string, string>;
      expect(headers["X-Service-Token"]).toBe("svc-token");
    }
  });
});

// ---------------------------------------------------------------------------
// handleExportRequest()
// ---------------------------------------------------------------------------

describe("GdprService.handleExportRequest()", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a presigned storage result_url on success", async () => {
    const deps = makeDeps();
    const svc = createGdprService(deps);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: { email: "user@example.com" } }),
        text: vi.fn().mockResolvedValue(""),
      }),
    );

    const result = await svc.handleExportRequest("req-0001", "user-1", "tenant-1");

    expect(result.requestId).toBe("req-0001");
    expect(result.resultUrl).toBe("https://storage.example/download");
  });

  it("persists result_url to the repository row", async () => {
    const deps = makeDeps();
    const svc = createGdprService(deps);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: {} }),
        text: vi.fn().mockResolvedValue(""),
      }),
    );

    await svc.handleExportRequest("req-0001", "user-1", "tenant-1");

    const updateCalls = (deps.gdprRequestRepo.updateStatus as ReturnType<typeof vi.fn>).mock.calls as Array<[string, { status: string; result_url?: string }]>;
    const exportUpdateCall = updateCalls.find(
      (c) => c[1].result_url !== undefined,
    );
    expect(exportUpdateCall).toBeDefined();
    expect(exportUpdateCall?.[1].result_url).toBe("https://storage.example/download");
  });
});
