// Unit tests for pipeline versioning: listVersions, getVersion, rollbackToVersion.
//
// All I/O is mocked with vi.fn(). The tests verify service-layer contracts
// (ownership checks, error types, delegation to repos) without hitting a database.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createPipelineService,
  type PipelineRow,
  type PipelineVersionRow,
  type PipelineRepository,
  type PipelineVersionRepository,
  type RunRepository,
  type ScheduleRepoForPipeline,
  type PipelineDefinition,
  type PipelineServiceDeps,
} from "../services/pipeline-service.js";
import {
  PipelineNotFoundError,
  PipelineVersionNotFoundError,
  PipelineValidationError,
} from "../services/errors.js";
import type { Logger } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Minimal valid definition fixture — satisfies validateDefinition
// ---------------------------------------------------------------------------

const minimalStep = {
  id: "step-1",
  name: "Code Step",
  type: "code" as const,
  language: "javascript" as const,
  code: 'return "hello";',
  onError: "fail" as const,
};

const minimalDefinition: PipelineDefinition = {
  version: 1,
  entryStepId: "step-1",
  steps: [minimalStep],
};

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

function makePipelineRow(overrides?: Partial<PipelineRow>): PipelineRow {
  return {
    id: "pipe-001",
    tenant_id: "tenant-001",
    name: "Test Pipeline",
    slug: "test-pipeline",
    description: null,
    definition: minimalDefinition as unknown as Record<string, unknown>,
    is_active: true,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    created_by: "user-001",
    current_version: 0,
    ...overrides,
  };
}

function makeVersionRow(overrides?: Partial<PipelineVersionRow>): PipelineVersionRow {
  return {
    id: "ver-001",
    pipeline_id: "pipe-001",
    tenant_id: "tenant-001",
    version_number: 1,
    definition_snapshot: minimalDefinition as unknown as Record<string, unknown>,
    name_at_version: "Test Pipeline",
    description_at_version: null,
    created_at: new Date("2026-01-02T00:00:00Z"),
    created_by: "user-001",
    ...overrides,
  };
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

type MockPipelineRepo = { [K in keyof PipelineRepository]: ReturnType<typeof vi.fn> };
type MockVersionRepo = { [K in keyof PipelineVersionRepository]: ReturnType<typeof vi.fn> };
type MockScheduleRepo = { disableByPipelineId: ReturnType<typeof vi.fn> };
type MockRunRepo = { countActiveByPipelineId: ReturnType<typeof vi.fn> };

function makePipelineRepo(): MockPipelineRepo {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    findByTenantAndId: vi.fn(),
    findByTenantAndSlug: vi.fn(),
    findByTenantId: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

function makeVersionRepo(): MockVersionRepo {
  return {
    listByPipelineId: vi.fn(),
    findByPipelineIdAndVersionNumber: vi.fn(),
  };
}

function makeScheduleRepo(): MockScheduleRepo {
  return { disableByPipelineId: vi.fn() };
}

function makeRunRepo(): MockRunRepo {
  return { countActiveByPipelineId: vi.fn() };
}

function makeDeps(overrides?: {
  pipelineRepo?: MockPipelineRepo;
  versionRepo?: MockVersionRepo;
  scheduleRepo?: MockScheduleRepo;
  runRepo?: MockRunRepo;
  logger?: Logger;
}): PipelineServiceDeps {
  return {
    pipelineRepo: (overrides?.pipelineRepo ?? makePipelineRepo()) as unknown as PipelineRepository,
    versionRepo: (overrides?.versionRepo ?? makeVersionRepo()) as unknown as PipelineVersionRepository,
    scheduleRepo: (overrides?.scheduleRepo ?? makeScheduleRepo()) as unknown as ScheduleRepoForPipeline,
    runRepo: (overrides?.runRepo ?? makeRunRepo()) as unknown as RunRepository,
    logger: overrides?.logger ?? makeLogger(),
  };
}

// ---------------------------------------------------------------------------
// listVersions
// ---------------------------------------------------------------------------

describe("listVersions", () => {
  let pipelineRepo: MockPipelineRepo;
  let versionRepo: MockVersionRepo;
  let service: ReturnType<typeof createPipelineService>;

  beforeEach(() => {
    pipelineRepo = makePipelineRepo();
    versionRepo = makeVersionRepo();
    service = createPipelineService(makeDeps({ pipelineRepo, versionRepo }));
  });

  it("throws PipelineNotFoundError when pipeline does not belong to tenant", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(
      service.listVersions("tenant-001", "pipe-999"),
    ).rejects.toThrow(PipelineNotFoundError);
  });

  it("returns version list from repo when pipeline exists", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(makePipelineRow());
    const versions = [makeVersionRow(), makeVersionRow({ version_number: 2, id: "ver-002" })];
    versionRepo.listByPipelineId.mockResolvedValue(versions);

    const result = await service.listVersions("tenant-001", "pipe-001");

    expect(result.data).toHaveLength(2);
    expect(versionRepo.listByPipelineId).toHaveBeenCalledWith(
      "pipe-001",
      expect.objectContaining({ limit: 50 }),
    );
  });

  it("sets nextCursor to last version_number when page is full", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(makePipelineRow());
    // Return exactly `limit` rows to signal more pages exist.
    const versions = Array.from({ length: 10 }, (_, i) =>
      makeVersionRow({ version_number: 10 - i, id: `ver-${String(i).padStart(3, "0")}` }),
    );
    versionRepo.listByPipelineId.mockResolvedValue(versions);

    const result = await service.listVersions("tenant-001", "pipe-001", { limit: 10 });

    // Last row has version_number=1; that becomes the cursor for the next page.
    expect(result.pagination.nextCursor).toBe(1);
  });

  it("sets nextCursor to null when fewer results than limit", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(makePipelineRow());
    versionRepo.listByPipelineId.mockResolvedValue([makeVersionRow()]);

    const result = await service.listVersions("tenant-001", "pipe-001", { limit: 50 });

    expect(result.pagination.nextCursor).toBeNull();
  });

  it("forwards cursor option to repo", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(makePipelineRow());
    versionRepo.listByPipelineId.mockResolvedValue([]);

    await service.listVersions("tenant-001", "pipe-001", { cursor: 5, limit: 10 });

    expect(versionRepo.listByPipelineId).toHaveBeenCalledWith(
      "pipe-001",
      expect.objectContaining({ cursor: 5, limit: 10 }),
    );
  });
});

// ---------------------------------------------------------------------------
// getVersion
// ---------------------------------------------------------------------------

describe("getVersion", () => {
  let pipelineRepo: MockPipelineRepo;
  let versionRepo: MockVersionRepo;
  let service: ReturnType<typeof createPipelineService>;

  beforeEach(() => {
    pipelineRepo = makePipelineRepo();
    versionRepo = makeVersionRepo();
    service = createPipelineService(makeDeps({ pipelineRepo, versionRepo }));
  });

  it("throws PipelineNotFoundError when pipeline does not belong to tenant", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(
      service.getVersion("tenant-001", "pipe-999", 1),
    ).rejects.toThrow(PipelineNotFoundError);
  });

  it("throws PipelineVersionNotFoundError when version does not exist", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(makePipelineRow());
    versionRepo.findByPipelineIdAndVersionNumber.mockResolvedValue(null);

    await expect(
      service.getVersion("tenant-001", "pipe-001", 99),
    ).rejects.toThrow(PipelineVersionNotFoundError);
  });

  it("returns version row when found", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(makePipelineRow());
    const versionRow = makeVersionRow();
    versionRepo.findByPipelineIdAndVersionNumber.mockResolvedValue(versionRow);

    const result = await service.getVersion("tenant-001", "pipe-001", 1);

    expect(result).toBe(versionRow);
    expect(versionRepo.findByPipelineIdAndVersionNumber).toHaveBeenCalledWith("pipe-001", 1);
  });

  it("does not call version repo when pipeline ownership check fails", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(service.getVersion("tenant-001", "pipe-001", 1)).rejects.toThrow();

    expect(versionRepo.findByPipelineIdAndVersionNumber).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// rollbackToVersion
// ---------------------------------------------------------------------------

describe("rollbackToVersion", () => {
  let pipelineRepo: MockPipelineRepo;
  let versionRepo: MockVersionRepo;
  let scheduleRepo: MockScheduleRepo;
  let logger: Logger;
  let service: ReturnType<typeof createPipelineService>;

  beforeEach(() => {
    pipelineRepo = makePipelineRepo();
    versionRepo = makeVersionRepo();
    scheduleRepo = makeScheduleRepo();
    logger = makeLogger();
    service = createPipelineService(makeDeps({ pipelineRepo, versionRepo, scheduleRepo, logger }));
  });

  it("throws PipelineNotFoundError when pipeline does not belong to tenant", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(
      service.rollbackToVersion("tenant-001", "pipe-999", 1, "user-001"),
    ).rejects.toThrow(PipelineNotFoundError);
  });

  it("throws PipelineVersionNotFoundError when target version does not exist", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(makePipelineRow());
    versionRepo.findByPipelineIdAndVersionNumber.mockResolvedValue(null);

    await expect(
      service.rollbackToVersion("tenant-001", "pipe-001", 99, "user-001"),
    ).rejects.toThrow(PipelineVersionNotFoundError);
  });

  it("calls updatePipeline with the snapshot definition and name from the version", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(makePipelineRow());
    const versionRow = makeVersionRow({ name_at_version: "Old Name" });
    versionRepo.findByPipelineIdAndVersionNumber.mockResolvedValue(versionRow);
    const updatedRow = makePipelineRow({ name: "Old Name", current_version: 2 });
    pipelineRepo.update.mockResolvedValue(updatedRow);

    const result = await service.rollbackToVersion("tenant-001", "pipe-001", 1, "user-001");

    expect(result.name).toBe("Old Name");
    // update() must be called with the snapshot definition
    const updateCallData = (pipelineRepo.update.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(updateCallData["definition"]).toEqual(versionRow.definition_snapshot);
  });

  it("passes userId as updatedBy so the rollback itself creates a version snapshot", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(makePipelineRow());
    versionRepo.findByPipelineIdAndVersionNumber.mockResolvedValue(makeVersionRow());
    pipelineRepo.update.mockResolvedValue(makePipelineRow({ current_version: 2 }));

    await service.rollbackToVersion("tenant-001", "pipe-001", 1, "user-rollback");

    // The third argument to pipelineRepo.update() is updatedBy
    const updatedBy = (pipelineRepo.update.mock.calls[0] as unknown[])[2] as string;
    expect(updatedBy).toBe("user-rollback");
  });

  it("throws PipelineValidationError when snapshot definition is no longer valid", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(makePipelineRow());
    // Snapshot has an entryStepId that references a non-existent step
    const badSnapshot: Record<string, unknown> = {
      version: 1,
      entryStepId: "missing-step",
      steps: [minimalStep],
    };
    versionRepo.findByPipelineIdAndVersionNumber.mockResolvedValue(
      makeVersionRow({ definition_snapshot: badSnapshot }),
    );

    await expect(
      service.rollbackToVersion("tenant-001", "pipe-001", 1, "user-001"),
    ).rejects.toThrow(PipelineValidationError);
  });

  it("does not call update when version is not found", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(makePipelineRow());
    versionRepo.findByPipelineIdAndVersionNumber.mockResolvedValue(null);

    await expect(
      service.rollbackToVersion("tenant-001", "pipe-001", 5, "user-001"),
    ).rejects.toThrow();

    expect(pipelineRepo.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// updatePipeline now passes updatedBy — regression tests
// ---------------------------------------------------------------------------

describe("updatePipeline — updatedBy forwarding", () => {
  let pipelineRepo: MockPipelineRepo;
  let versionRepo: MockVersionRepo;
  let scheduleRepo: MockScheduleRepo;
  let service: ReturnType<typeof createPipelineService>;

  beforeEach(() => {
    pipelineRepo = makePipelineRepo();
    versionRepo = makeVersionRepo();
    scheduleRepo = makeScheduleRepo();
    service = createPipelineService(makeDeps({ pipelineRepo, versionRepo, scheduleRepo }));
  });

  it("forwards updatedBy to pipelineRepo.update when provided", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(makePipelineRow());
    pipelineRepo.update.mockResolvedValue(makePipelineRow({ current_version: 1 }));

    await service.updatePipeline("tenant-001", "pipe-001", { name: "New Name" }, "user-xyz");

    const updatedBy = (pipelineRepo.update.mock.calls[0] as unknown[])[2];
    expect(updatedBy).toBe("user-xyz");
  });

  it("calls pipelineRepo.update with undefined updatedBy when not provided", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(makePipelineRow());
    pipelineRepo.update.mockResolvedValue(makePipelineRow({ current_version: 1 }));

    await service.updatePipeline("tenant-001", "pipe-001", { name: "New Name" });

    const updatedBy = (pipelineRepo.update.mock.calls[0] as unknown[])[2];
    expect(updatedBy).toBeUndefined();
  });
});
