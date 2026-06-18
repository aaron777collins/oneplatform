// Unit tests for services/pipeline-service.ts
//
// Covers createPipeline, getPipeline, listPipelines, updatePipeline,
// deletePipeline, and validateDefinition. All I/O dependencies (repos, logger)
// are replaced with vi.fn() mocks.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createPipelineService,
  type PipelineRow,
  type PipelineDefinition,
  type PipelineRepository,
  type PipelineVersionRepository,
  type RunRepository,
  type ScheduleRepoForPipeline,
  type PipelineListResult,
  type PipelineListQuery,
  type PipelineServiceDeps,
} from "../services/pipeline-service.js";
import {
  PipelineNotFoundError,
  PipelineValidationError,
  PipelineRunsActiveError,
} from "../services/errors.js";
import type { Logger } from "@oneplatform/core";

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
    definition: minimalDefinition as unknown as PipelineDefinition,
    is_active: true,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    created_by: "user-001",
    current_version: 0,
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

type MockPipelineRepo = {
  create: ReturnType<typeof vi.fn>;
  findById: ReturnType<typeof vi.fn>;
  findByTenantAndId: ReturnType<typeof vi.fn>;
  findByTenantAndSlug: ReturnType<typeof vi.fn>;
  findByTenantId: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

type MockVersionRepo = {
  listByPipelineId: ReturnType<typeof vi.fn>;
  findByPipelineIdAndVersionNumber: ReturnType<typeof vi.fn>;
};

type MockScheduleRepo = {
  disableByPipelineId: ReturnType<typeof vi.fn>;
};

type MockRunRepo = {
  countActiveByPipelineId: ReturnType<typeof vi.fn>;
};

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
  return {
    disableByPipelineId: vi.fn(),
  };
}

function makeRunRepo(): MockRunRepo {
  return {
    countActiveByPipelineId: vi.fn(),
  };
}

function makeDeps(
  overrides?: Partial<{
    pipelineRepo: MockPipelineRepo;
    versionRepo: MockVersionRepo;
    scheduleRepo: MockScheduleRepo;
    runRepo: MockRunRepo;
    logger: Logger;
  }>,
): PipelineServiceDeps {
  return {
    pipelineRepo: (overrides?.pipelineRepo ?? makePipelineRepo()) as unknown as PipelineRepository,
    versionRepo: (overrides?.versionRepo ?? makeVersionRepo()) as unknown as PipelineVersionRepository,
    scheduleRepo: (overrides?.scheduleRepo ?? makeScheduleRepo()) as unknown as ScheduleRepoForPipeline,
    runRepo: (overrides?.runRepo ?? makeRunRepo()) as unknown as RunRepository,
    logger: overrides?.logger ?? makeLogger(),
  };
}

// ---------------------------------------------------------------------------
// Shared test fixtures
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
// validateDefinition — pure logic, no I/O
// ---------------------------------------------------------------------------

describe("validateDefinition — valid definitions", () => {
  let service: ReturnType<typeof createPipelineService>;

  beforeEach(() => {
    service = createPipelineService(makeDeps());
  });

  it("returns valid=true for a minimal single-step definition", () => {
    const result = service.validateDefinition(minimalDefinition);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("returns valid=true for a definition with multiple sequential steps", () => {
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "s1",
      steps: [
        { id: "s1", name: "S1", type: "code", language: "typescript", code: "x", onError: "fail" },
        { id: "s2", name: "S2", type: "code", language: "python", code: "x", onError: "fail" },
        { id: "s3", name: "S3", type: "code", language: "go", code: "x", onError: "fail" },
      ],
    };
    const result = service.validateDefinition(definition);
    expect(result.valid).toBe(true);
  });

  it("returns valid=true for a definition with valid conditional branch targets", () => {
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "cond",
      steps: [
        {
          id: "cond",
          name: "Cond",
          type: "conditional",
          condition: { field: "flag", operator: "eq" as const, value: true },
          thenStepId: "step-yes",
          elseStepId: "step-no",
          onError: "fail",
        },
        { id: "step-yes", name: "Yes", type: "code", language: "javascript", code: "x", onError: "fail" },
        { id: "step-no", name: "No", type: "code", language: "javascript", code: "x", onError: "fail" },
      ],
    };
    const result = service.validateDefinition(definition);
    expect(result.valid).toBe(true);
  });

  it("returns valid=true for a definition with a parallel step and valid branch entries", () => {
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "par",
      steps: [
        {
          id: "par",
          name: "Parallel",
          type: "parallel",
          branches: [
            {
              id: "b1",
              entryStepId: "s-a",
              steps: [{ id: "s-a", name: "A", type: "code", language: "javascript", code: "x", onError: "fail" }],
            },
            {
              id: "b2",
              entryStepId: "s-b",
              steps: [{ id: "s-b", name: "B", type: "code", language: "javascript", code: "x", onError: "fail" }],
            },
          ],
          waitMode: "all",
          onError: "fail",
        },
      ],
    };
    const result = service.validateDefinition(definition);
    expect(result.valid).toBe(true);
  });

  it("returns valid=true for a webhook step with a safe public HTTPS URL", () => {
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "wh",
      steps: [
        {
          id: "wh",
          name: "Webhook",
          type: "webhook",
          url: "https://api.example.com/callback",
          method: "POST",
          onError: "fail",
        },
      ],
    };
    const result = service.validateDefinition(definition);
    expect(result.valid).toBe(true);
  });
});

describe("validateDefinition — invalid definitions", () => {
  let service: ReturnType<typeof createPipelineService>;

  beforeEach(() => {
    service = createPipelineService(makeDeps());
  });

  it("returns valid=false when entryStepId references a non-existent step", () => {
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "does-not-exist",
      steps: [minimalStep],
    };
    const result = service.validateDefinition(definition);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    const firstError = result.errors[0];
    expect(firstError).toContain("does-not-exist");
  });

  it("returns valid=false when conditional thenStepId references missing step", () => {
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "cond",
      steps: [
        {
          id: "cond",
          name: "Cond",
          type: "conditional",
          condition: { field: "flag", operator: "exists" as const },
          thenStepId: "missing-true",
          elseStepId: "step-no",
          onError: "fail",
        },
        { id: "step-no", name: "No", type: "code", language: "javascript", code: "x", onError: "fail" },
      ],
    };
    const result = service.validateDefinition(definition);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("missing-true"))).toBe(true);
  });

  it("returns valid=false when conditional elseStepId references missing step", () => {
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "cond",
      steps: [
        {
          id: "cond",
          name: "Cond",
          type: "conditional",
          condition: { field: "flag", operator: "exists" as const },
          thenStepId: "step-yes",
          elseStepId: "missing-false",
          onError: "fail",
        },
        { id: "step-yes", name: "Yes", type: "code", language: "javascript", code: "x", onError: "fail" },
      ],
    };
    const result = service.validateDefinition(definition);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("missing-false"))).toBe(true);
  });

  it("returns valid=false when parallel branch entryStepId is missing from all steps", () => {
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "par",
      steps: [
        {
          id: "par",
          name: "Parallel",
          type: "parallel",
          branches: [
            {
              id: "b1",
              entryStepId: "missing-entry",
              steps: [],
            },
            {
              id: "b2",
              entryStepId: "s-b",
              steps: [{ id: "s-b", name: "B", type: "code", language: "javascript", code: "x", onError: "fail" }],
            },
          ],
          waitMode: "all",
          onError: "fail",
        },
      ],
    };
    const result = service.validateDefinition(definition);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("missing-entry"))).toBe(true);
  });

  it("returns valid=false for webhook step with localhost URL (SSRF)", () => {
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "wh",
      steps: [
        {
          id: "wh",
          name: "Webhook",
          type: "webhook",
          url: "https://localhost/callback",
          method: "POST",
          onError: "fail",
        },
      ],
    };
    const result = service.validateDefinition(definition);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("SSRF"))).toBe(true);
  });

  it("returns valid=false for webhook step with 10.x.x.x (RFC-1918) URL", () => {
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "wh",
      steps: [
        {
          id: "wh",
          name: "Webhook",
          type: "webhook",
          url: "https://10.0.0.1/callback",
          method: "POST",
          onError: "fail",
        },
      ],
    };
    const result = service.validateDefinition(definition);
    expect(result.valid).toBe(false);
  });

  it("returns valid=false for webhook step with 192.168.x.x URL", () => {
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "wh",
      steps: [
        {
          id: "wh",
          name: "Webhook",
          type: "webhook",
          url: "https://192.168.1.100/callback",
          method: "POST",
          onError: "fail",
        },
      ],
    };
    const result = service.validateDefinition(definition);
    expect(result.valid).toBe(false);
  });

  it("returns valid=false for webhook step with 127.x.x.x URL", () => {
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "wh",
      steps: [
        {
          id: "wh",
          name: "Webhook",
          type: "webhook",
          url: "https://127.0.0.1/callback",
          method: "POST",
          onError: "fail",
        },
      ],
    };
    const result = service.validateDefinition(definition);
    expect(result.valid).toBe(false);
  });

  it("accumulates multiple errors when several step references are invalid", () => {
    const definition: PipelineDefinition = {
      version: 1,
      entryStepId: "missing-entry",
      steps: [
        {
          id: "cond",
          name: "Cond",
          type: "conditional",
          condition: { field: "x", operator: "exists" as const },
          thenStepId: "missing-true",
          elseStepId: "missing-false",
          onError: "fail",
        },
      ],
    };
    const result = service.validateDefinition(definition);
    expect(result.valid).toBe(false);
    // entryStepId + thenStepId + elseStepId are all missing => at least 3 errors
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// createPipeline
// ---------------------------------------------------------------------------

describe("createPipeline", () => {
  let pipelineRepo: MockPipelineRepo;
  let scheduleRepo: MockScheduleRepo;
  let runRepo: MockRunRepo;
  let logger: Logger;
  let service: ReturnType<typeof createPipelineService>;

  beforeEach(() => {
    pipelineRepo = makePipelineRepo();
    scheduleRepo = makeScheduleRepo();
    runRepo = makeRunRepo();
    logger = makeLogger();
    service = createPipelineService(makeDeps({ pipelineRepo, scheduleRepo, runRepo, logger }));
  });

  it("creates a pipeline and returns the row from the repo", async () => {
    const expectedRow = makePipelineRow();
    pipelineRepo.create.mockResolvedValue(expectedRow);

    const result = await service.createPipeline("tenant-001", "user-001", {
      name: "Test Pipeline",
      definition: minimalDefinition,
      isActive: true,
    });

    expect(result).toBe(expectedRow);
    expect(pipelineRepo.create).toHaveBeenCalledOnce();
  });

  it("derives slug from name when slug is not provided", async () => {
    const row = makePipelineRow({ slug: "my-test-pipeline" });
    pipelineRepo.create.mockResolvedValue(row);

    await service.createPipeline("tenant-001", "user-001", {
      name: "My Test Pipeline",
      definition: minimalDefinition,
      isActive: true,
    });

    const createCallArg = (pipelineRepo.create.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(createCallArg["slug"]).toBe("my-test-pipeline");
  });

  it("uses provided slug when given", async () => {
    const row = makePipelineRow({ slug: "custom-slug" });
    pipelineRepo.create.mockResolvedValue(row);

    await service.createPipeline("tenant-001", "user-001", {
      name: "My Pipeline",
      slug: "custom-slug",
      definition: minimalDefinition,
      isActive: true,
    });

    const createCallArg = (pipelineRepo.create.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(createCallArg["slug"]).toBe("custom-slug");
  });

  it("throws PipelineValidationError when definition has invalid entryStepId", async () => {
    const badDefinition: PipelineDefinition = {
      version: 1,
      entryStepId: "nonexistent",
      steps: [minimalStep],
    };

    await expect(
      service.createPipeline("tenant-001", "user-001", {
        name: "Bad Pipeline",
        definition: badDefinition,
        isActive: true,
      }),
    ).rejects.toThrow(PipelineValidationError);
  });

  it("throws PipelineValidationError for SSRF webhook URL — validateDefinition fires first", async () => {
    // validateDefinition catches SSRF and raises PipelineValidationError.
    // The per-step PipelineInvalidWebhookUrlError path only fires when validation
    // passes, which can't happen for a URL that is in the SSRF blocklist.
    const ssrfDefinition: PipelineDefinition = {
      version: 1,
      entryStepId: "wh",
      steps: [
        {
          id: "wh",
          name: "Webhook",
          type: "webhook",
          url: "https://127.0.0.1/hook",
          method: "POST",
          onError: "fail",
        },
      ],
    };

    await expect(
      service.createPipeline("tenant-001", "user-001", {
        name: "SSRF Pipeline",
        definition: ssrfDefinition,
        isActive: true,
      }),
    ).rejects.toThrow(PipelineValidationError);
  });

  it("logs an info message after successful creation", async () => {
    pipelineRepo.create.mockResolvedValue(makePipelineRow());

    await service.createPipeline("tenant-001", "user-001", {
      name: "Test Pipeline",
      definition: minimalDefinition,
      isActive: true,
    });

    const loggerInfo = logger.info as ReturnType<typeof vi.fn>;
    expect(loggerInfo).toHaveBeenCalledWith(
      "Pipeline created",
      expect.objectContaining({ tenantId: "tenant-001" }),
    );
  });

  it("does not call repo.create when definition validation fails", async () => {
    const badDefinition: PipelineDefinition = {
      version: 1,
      entryStepId: "missing",
      steps: [minimalStep],
    };

    await expect(
      service.createPipeline("t", "u", { name: "x", definition: badDefinition, isActive: true }),
    ).rejects.toThrow();

    expect(pipelineRepo.create).not.toHaveBeenCalled();
  });

  it("passes description to repo when provided", async () => {
    pipelineRepo.create.mockResolvedValue(makePipelineRow());

    await service.createPipeline("tenant-001", "user-001", {
      name: "My Pipeline",
      description: "A description",
      definition: minimalDefinition,
      isActive: true,
    });

    const createCallArg = (pipelineRepo.create.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(createCallArg["description"]).toBe("A description");
  });
});

// ---------------------------------------------------------------------------
// getPipeline
// ---------------------------------------------------------------------------

describe("getPipeline", () => {
  let pipelineRepo: MockPipelineRepo;
  let service: ReturnType<typeof createPipelineService>;

  beforeEach(() => {
    pipelineRepo = makePipelineRepo();
    service = createPipelineService(makeDeps({ pipelineRepo }));
  });

  it("returns the pipeline row when found", async () => {
    const row = makePipelineRow();
    pipelineRepo.findByTenantAndId.mockResolvedValue(row);

    const result = await service.getPipeline("tenant-001", "pipe-001");
    expect(result).toBe(row);
  });

  it("throws PipelineNotFoundError when pipeline does not exist", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(service.getPipeline("tenant-001", "pipe-999")).rejects.toThrow(
      PipelineNotFoundError,
    );
  });

  it("passes tenantId and id to findByTenantAndId", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(service.getPipeline("tenant-001", "pipe-xyz")).rejects.toThrow();
    expect(pipelineRepo.findByTenantAndId).toHaveBeenCalledWith("tenant-001", "pipe-xyz");
  });
});

// ---------------------------------------------------------------------------
// listPipelines
// ---------------------------------------------------------------------------

describe("listPipelines", () => {
  let pipelineRepo: MockPipelineRepo;
  let service: ReturnType<typeof createPipelineService>;

  beforeEach(() => {
    pipelineRepo = makePipelineRepo();
    service = createPipelineService(makeDeps({ pipelineRepo }));
  });

  it("returns data and pagination from repo.findByTenantId", async () => {
    const rows = [makePipelineRow()];
    pipelineRepo.findByTenantId.mockResolvedValue(rows);

    const query: PipelineListQuery = { limit: 20 };
    const result = await service.listPipelines("tenant-001", query);

    expect(result.data).toHaveLength(1);
    expect(pipelineRepo.findByTenantId).toHaveBeenCalledWith("tenant-001", expect.objectContaining({ limit: 20 }));
  });

  it("returns pagination.nextCursor as null when result count is less than limit", async () => {
    pipelineRepo.findByTenantId.mockResolvedValue([makePipelineRow()]);

    const result = await service.listPipelines("tenant-001", { limit: 50 });
    expect(result.pagination.nextCursor).toBeNull();
  });

  it("returns pagination.nextCursor as last row id when result count equals limit", async () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      makePipelineRow({ id: `pipe-${String(i).padStart(3, "0")}` }),
    );
    pipelineRepo.findByTenantId.mockResolvedValue(rows);

    const result = await service.listPipelines("tenant-001", { limit: 20 });
    expect(result.pagination.nextCursor).toBe("pipe-019");
  });

  it("passes filterIsActive to repo when provided", async () => {
    pipelineRepo.findByTenantId.mockResolvedValue([]);

    const query: PipelineListQuery = { limit: 50, filterIsActive: true };
    await service.listPipelines("tenant-001", query);

    expect(pipelineRepo.findByTenantId).toHaveBeenCalledWith(
      "tenant-001",
      expect.objectContaining({ filterIsActive: true }),
    );
  });
});

// ---------------------------------------------------------------------------
// updatePipeline
// ---------------------------------------------------------------------------

describe("updatePipeline", () => {
  let pipelineRepo: MockPipelineRepo;
  let scheduleRepo: MockScheduleRepo;
  let logger: Logger;
  let service: ReturnType<typeof createPipelineService>;

  beforeEach(() => {
    pipelineRepo = makePipelineRepo();
    scheduleRepo = makeScheduleRepo();
    logger = makeLogger();
    service = createPipelineService(makeDeps({ pipelineRepo, scheduleRepo, logger }));
  });

  it("throws PipelineNotFoundError when pipeline does not exist", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(
      service.updatePipeline("tenant-001", "pipe-999", { name: "New Name" }),
    ).rejects.toThrow(PipelineNotFoundError);
  });

  it("updates pipeline and returns updated row", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(makePipelineRow());
    pipelineRepo.update.mockResolvedValue(makePipelineRow({ name: "Updated Name" }));

    const result = await service.updatePipeline("tenant-001", "pipe-001", { name: "Updated Name" });
    expect(result.name).toBe("Updated Name");
  });

  it("throws PipelineValidationError when new definition has invalid entryStepId", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(makePipelineRow());

    const badDefinition: PipelineDefinition = {
      version: 1,
      entryStepId: "missing",
      steps: [minimalStep],
    };

    await expect(
      service.updatePipeline("tenant-001", "pipe-001", { definition: badDefinition }),
    ).rejects.toThrow(PipelineValidationError);
  });

  it("throws PipelineValidationError when new definition has SSRF webhook", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(makePipelineRow());

    const ssrfDefinition: PipelineDefinition = {
      version: 1,
      entryStepId: "wh",
      steps: [
        {
          id: "wh",
          name: "Webhook",
          type: "webhook",
          url: "https://10.0.0.1/hook",
          method: "POST",
          onError: "fail",
        },
      ],
    };

    await expect(
      service.updatePipeline("tenant-001", "pipe-001", { definition: ssrfDefinition }),
    ).rejects.toThrow(PipelineValidationError);
  });

  it("disables schedules when isActive is set to false", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(makePipelineRow());
    pipelineRepo.update.mockResolvedValue(makePipelineRow({ is_active: false }));
    scheduleRepo.disableByPipelineId.mockResolvedValue(undefined);

    await service.updatePipeline("tenant-001", "pipe-001", { isActive: false });

    expect(scheduleRepo.disableByPipelineId).toHaveBeenCalledWith("pipe-001");
  });

  it("does not disable schedules when isActive is set to true", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(makePipelineRow());
    pipelineRepo.update.mockResolvedValue(makePipelineRow({ is_active: true }));

    await service.updatePipeline("tenant-001", "pipe-001", { isActive: true });

    expect(scheduleRepo.disableByPipelineId).not.toHaveBeenCalled();
  });

  it("does not disable schedules when isActive is not included in update", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(makePipelineRow());
    pipelineRepo.update.mockResolvedValue(makePipelineRow());

    await service.updatePipeline("tenant-001", "pipe-001", { name: "new name" });

    expect(scheduleRepo.disableByPipelineId).not.toHaveBeenCalled();
  });

  it("logs an info message after successful update", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(makePipelineRow());
    pipelineRepo.update.mockResolvedValue(makePipelineRow());

    await service.updatePipeline("tenant-001", "pipe-001", { name: "Updated" });

    const loggerInfo = logger.info as ReturnType<typeof vi.fn>;
    expect(loggerInfo).toHaveBeenCalledWith(
      "Pipeline updated",
      expect.objectContaining({ tenantId: "tenant-001", pipelineId: "pipe-001" }),
    );
  });

  it("throws PipelineNotFoundError when repo.update returns null (row deleted mid-flight)", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(makePipelineRow());
    pipelineRepo.update.mockResolvedValue(null);

    await expect(
      service.updatePipeline("tenant-001", "pipe-001", { name: "Updated" }),
    ).rejects.toThrow(PipelineNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// deletePipeline
// ---------------------------------------------------------------------------

describe("deletePipeline", () => {
  let pipelineRepo: MockPipelineRepo;
  let runRepo: MockRunRepo;
  let logger: Logger;
  let service: ReturnType<typeof createPipelineService>;

  beforeEach(() => {
    pipelineRepo = makePipelineRepo();
    runRepo = makeRunRepo();
    logger = makeLogger();
    service = createPipelineService(makeDeps({ pipelineRepo, runRepo, logger }));
  });

  it("throws PipelineNotFoundError when pipeline does not exist", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(service.deletePipeline("tenant-001", "pipe-999")).rejects.toThrow(
      PipelineNotFoundError,
    );
  });

  it("throws PipelineRunsActiveError when active runs exist", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(makePipelineRow());
    runRepo.countActiveByPipelineId.mockResolvedValue(2);

    await expect(service.deletePipeline("tenant-001", "pipe-001")).rejects.toThrow(
      PipelineRunsActiveError,
    );
  });

  it("deletes pipeline when no active runs exist", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(makePipelineRow());
    runRepo.countActiveByPipelineId.mockResolvedValue(0);
    pipelineRepo.delete.mockResolvedValue(true);

    await service.deletePipeline("tenant-001", "pipe-001");

    expect(pipelineRepo.delete).toHaveBeenCalledWith("pipe-001");
  });

  it("logs an info message after successful deletion", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(makePipelineRow());
    runRepo.countActiveByPipelineId.mockResolvedValue(0);
    pipelineRepo.delete.mockResolvedValue(true);

    await service.deletePipeline("tenant-001", "pipe-001");

    const loggerInfo = logger.info as ReturnType<typeof vi.fn>;
    expect(loggerInfo).toHaveBeenCalledWith(
      "Pipeline deleted",
      expect.objectContaining({ tenantId: "tenant-001", pipelineId: "pipe-001" }),
    );
  });

  it("does not call repo.delete when pipeline is not found", async () => {
    pipelineRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(service.deletePipeline("t", "missing")).rejects.toThrow();
    expect(pipelineRepo.delete).not.toHaveBeenCalled();
  });
});
