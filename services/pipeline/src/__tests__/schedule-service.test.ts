// Unit tests for services/schedule-service.ts
//
// Covers CRUD operations, cron expression validation (5-field only),
// computeNextRunAt timezone handling, and due schedule triggering via cronTick.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createScheduleService,
  type ScheduleRow,
  type ScheduleRepository,
  type ScheduleListResult,
  type ScheduleListQuery,
  type ScheduleService,
} from "../services/schedule-service.js";
import type { PipelineRow } from "../services/pipeline-service.js";
import type { RunService, TriggerRunResult } from "../services/run-service.js";
import {
  ScheduleNotFoundError,
  ScheduleInvalidCronError,
} from "../services/errors.js";
import type { Logger } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

type MockScheduleRepo = {
  create: ReturnType<typeof vi.fn>;
  findById: ReturnType<typeof vi.fn>;
  findByIdWithTenant: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  findAllEnabled: ReturnType<typeof vi.fn>;
  findDueSchedules: ReturnType<typeof vi.fn>;
  claimScheduleRun: ReturnType<typeof vi.fn>;
};

type MockPipelineRepo = {
  findById: ReturnType<typeof vi.fn>;
};

type MockRunService = {
  triggerRun: ReturnType<typeof vi.fn>;
};

// Inline PipelineRepo interface (mirrors the private one inside schedule-service)
interface PipelineRepoShape {
  findById(id: string): Promise<PipelineRow | null>;
}

function makeScheduleRepo(): MockScheduleRepo {
  return {
    create: vi.fn(),
    findById: vi.fn(),
    findByIdWithTenant: vi.fn(),
    list: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    findAllEnabled: vi.fn(),
    findDueSchedules: vi.fn(),
    claimScheduleRun: vi.fn(),
  };
}

function makePipelineRepo(): MockPipelineRepo & PipelineRepoShape {
  return { findById: vi.fn() } as unknown as MockPipelineRepo & PipelineRepoShape;
}

function makeRunService(): MockRunService {
  return { triggerRun: vi.fn() };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const UUID_PIPELINE = "550e8400-e29b-41d4-a716-446655440000";
const UUID_TENANT = "550e8400-e29b-41d4-a716-446655440001";

function makeScheduleRow(overrides?: Partial<ScheduleRow>): ScheduleRow {
  return {
    id: "sched-001",
    pipeline_id: UUID_PIPELINE,
    tenant_id: UUID_TENANT,
    cron_expr: "0 * * * *",
    timezone: "UTC",
    enabled: true,
    input_template: {},
    last_run_at: null,
    next_run_at: new Date("2026-01-01T01:00:00Z"),
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makePipelineRow(overrides?: Partial<PipelineRow>): PipelineRow {
  return {
    id: UUID_PIPELINE,
    tenant_id: UUID_TENANT,
    name: "Test Pipeline",
    slug: "test-pipeline",
    description: null,
    definition: { version: 1, entryStepId: "s1", steps: [] } as unknown as PipelineRow["definition"],
    is_active: true,
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-01T00:00:00Z"),
    created_by: "user-001",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createSchedule
// ---------------------------------------------------------------------------

describe("createSchedule — valid cron expressions", () => {
  let scheduleRepo: MockScheduleRepo;
  let pipelineRepo: MockPipelineRepo & PipelineRepoShape;
  let service: ScheduleService;
  let logger: Logger;

  beforeEach(() => {
    scheduleRepo = makeScheduleRepo();
    pipelineRepo = makePipelineRepo();
    logger = makeLogger();
    service = createScheduleService({
      scheduleRepo: scheduleRepo as unknown as ScheduleRepository,
      pipelineRepo,
      runService: makeRunService() as unknown as RunService,
      logger,
    });
    pipelineRepo.findById.mockResolvedValue(makePipelineRow());
    scheduleRepo.create.mockResolvedValue(makeScheduleRow());
  });

  it("creates schedule with a standard hourly cron (0 * * * *)", async () => {
    const result = await service.createSchedule(UUID_TENANT, {
      pipelineId: UUID_PIPELINE,
      cronExpr: "0 * * * *",
      timezone: "UTC",
      enabled: true,
      inputTemplate: {},
    });
    expect(result.id).toBe("sched-001");
  });

  it("creates schedule with a daily cron (0 0 * * *)", async () => {
    scheduleRepo.create.mockResolvedValue(makeScheduleRow({ cron_expr: "0 0 * * *" }));
    const result = await service.createSchedule(UUID_TENANT, {
      pipelineId: UUID_PIPELINE,
      cronExpr: "0 0 * * *",
      timezone: "UTC",
      enabled: true,
      inputTemplate: {},
    });
    expect(result.cron_expr).toBe("0 0 * * *");
  });

  it("creates schedule with a weekday cron (0 9 * * 1-5)", async () => {
    const result = await service.createSchedule(UUID_TENANT, {
      pipelineId: UUID_PIPELINE,
      cronExpr: "0 9 * * 1-5",
      timezone: "America/New_York",
      enabled: true,
      inputTemplate: {},
    });
    expect(result).toBeDefined();
  });

  it("creates schedule with every-5-minutes cron (*/5 * * * *)", async () => {
    const result = await service.createSchedule(UUID_TENANT, {
      pipelineId: UUID_PIPELINE,
      cronExpr: "*/5 * * * *",
      timezone: "UTC",
      enabled: true,
      inputTemplate: {},
    });
    expect(result).toBeDefined();
  });

  it("passes nextRunAt to the repository create call", async () => {
    await service.createSchedule(UUID_TENANT, {
      pipelineId: UUID_PIPELINE,
      cronExpr: "0 * * * *",
      timezone: "UTC",
      enabled: true,
      inputTemplate: {},
    });

    const createArg = (scheduleRepo.create.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(createArg["nextRunAt"]).toBeInstanceOf(Date);
  });

  it("logs info message after creation", async () => {
    await service.createSchedule(UUID_TENANT, {
      pipelineId: UUID_PIPELINE,
      cronExpr: "0 * * * *",
      timezone: "UTC",
      enabled: true,
      inputTemplate: {},
    });

    const loggerInfo = logger.info as ReturnType<typeof vi.fn>;
    expect(loggerInfo).toHaveBeenCalledWith(
      "Schedule created",
      expect.objectContaining({ tenantId: UUID_TENANT }),
    );
  });
});

describe("createSchedule — invalid cron expressions", () => {
  let service: ScheduleService;

  beforeEach(() => {
    service = createScheduleService({
      scheduleRepo: makeScheduleRepo() as unknown as ScheduleRepository,
      pipelineRepo: makePipelineRepo(),
      runService: makeRunService() as unknown as RunService,
      logger: makeLogger(),
    });
  });

  it("throws ScheduleInvalidCronError for 6-field cron expression (seconds)", async () => {
    await expect(
      service.createSchedule(UUID_TENANT, {
        pipelineId: UUID_PIPELINE,
        cronExpr: "0 0 * * * *", // 6 fields
        timezone: "UTC",
        enabled: true,
        inputTemplate: {},
      }),
    ).rejects.toThrow(ScheduleInvalidCronError);
  });

  it("throws ScheduleInvalidCronError for a 4-field expression (too few fields)", async () => {
    await expect(
      service.createSchedule(UUID_TENANT, {
        pipelineId: UUID_PIPELINE,
        cronExpr: "0 * * *", // 4 fields
        timezone: "UTC",
        enabled: true,
        inputTemplate: {},
      }),
    ).rejects.toThrow(ScheduleInvalidCronError);
  });

  it("throws ScheduleInvalidCronError for a syntactically invalid cron expression", async () => {
    await expect(
      service.createSchedule(UUID_TENANT, {
        pipelineId: UUID_PIPELINE,
        cronExpr: "invalid cron expr here",
        timezone: "UTC",
        enabled: true,
        inputTemplate: {},
      }),
    ).rejects.toThrow(ScheduleInvalidCronError);
  });

  it("throws ScheduleNotFoundError when pipeline does not exist", async () => {
    const pipelineRepo = makePipelineRepo();
    pipelineRepo.findById.mockResolvedValue(null);
    const svc = createScheduleService({
      scheduleRepo: makeScheduleRepo() as unknown as ScheduleRepository,
      pipelineRepo,
      runService: makeRunService() as unknown as RunService,
      logger: makeLogger(),
    });

    await expect(
      svc.createSchedule(UUID_TENANT, {
        pipelineId: UUID_PIPELINE,
        cronExpr: "0 * * * *",
        timezone: "UTC",
        enabled: true,
        inputTemplate: {},
      }),
    ).rejects.toThrow(ScheduleNotFoundError);
  });

  it("throws ScheduleNotFoundError when pipeline belongs to different tenant", async () => {
    const pipelineRepo = makePipelineRepo();
    pipelineRepo.findById.mockResolvedValue(makePipelineRow({ tenant_id: "other-tenant" }));
    const svc = createScheduleService({
      scheduleRepo: makeScheduleRepo() as unknown as ScheduleRepository,
      pipelineRepo,
      runService: makeRunService() as unknown as RunService,
      logger: makeLogger(),
    });

    await expect(
      svc.createSchedule(UUID_TENANT, {
        pipelineId: UUID_PIPELINE,
        cronExpr: "0 * * * *",
        timezone: "UTC",
        enabled: true,
        inputTemplate: {},
      }),
    ).rejects.toThrow(ScheduleNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// getSchedule
// ---------------------------------------------------------------------------

describe("getSchedule", () => {
  let scheduleRepo: MockScheduleRepo;
  let service: ScheduleService;

  beforeEach(() => {
    scheduleRepo = makeScheduleRepo();
    service = createScheduleService({
      scheduleRepo: scheduleRepo as unknown as ScheduleRepository,
      pipelineRepo: makePipelineRepo(),
      runService: makeRunService() as unknown as RunService,
      logger: makeLogger(),
    });
  });

  it("returns the schedule when found", async () => {
    scheduleRepo.findByIdWithTenant.mockResolvedValue(makeScheduleRow());

    const result = await service.getSchedule(UUID_TENANT, "sched-001");
    expect(result.id).toBe("sched-001");
  });

  it("throws ScheduleNotFoundError when schedule does not exist", async () => {
    scheduleRepo.findByIdWithTenant.mockResolvedValue(null);

    await expect(service.getSchedule(UUID_TENANT, "sched-999")).rejects.toThrow(
      ScheduleNotFoundError,
    );
  });

  it("passes tenantId and scheduleId to findByIdWithTenant", async () => {
    scheduleRepo.findByIdWithTenant.mockResolvedValue(null);

    await expect(service.getSchedule(UUID_TENANT, "sched-abc")).rejects.toThrow();
    expect(scheduleRepo.findByIdWithTenant).toHaveBeenCalledWith(UUID_TENANT, "sched-abc");
  });
});

// ---------------------------------------------------------------------------
// listSchedules
// ---------------------------------------------------------------------------

describe("listSchedules", () => {
  let scheduleRepo: MockScheduleRepo;
  let service: ScheduleService;

  beforeEach(() => {
    scheduleRepo = makeScheduleRepo();
    service = createScheduleService({
      scheduleRepo: scheduleRepo as unknown as ScheduleRepository,
      pipelineRepo: makePipelineRepo(),
      runService: makeRunService() as unknown as RunService,
      logger: makeLogger(),
    });
  });

  it("delegates directly to repo.list and returns the result", async () => {
    const expectedResult: ScheduleListResult = {
      data: [],
      pagination: { nextCursor: null, total: 0 },
    };
    scheduleRepo.list.mockResolvedValue(expectedResult);

    const query: ScheduleListQuery = { limit: 20 };
    const result = await service.listSchedules(UUID_TENANT, query);

    expect(result).toBe(expectedResult);
    expect(scheduleRepo.list).toHaveBeenCalledWith(UUID_TENANT, query);
  });
});

// ---------------------------------------------------------------------------
// updateSchedule
// ---------------------------------------------------------------------------

describe("updateSchedule", () => {
  let scheduleRepo: MockScheduleRepo;
  let service: ScheduleService;
  let logger: Logger;

  beforeEach(() => {
    scheduleRepo = makeScheduleRepo();
    logger = makeLogger();
    service = createScheduleService({
      scheduleRepo: scheduleRepo as unknown as ScheduleRepository,
      pipelineRepo: makePipelineRepo(),
      runService: makeRunService() as unknown as RunService,
      logger,
    });
  });

  it("throws ScheduleNotFoundError when schedule does not exist", async () => {
    scheduleRepo.findByIdWithTenant.mockResolvedValue(null);

    await expect(
      service.updateSchedule(UUID_TENANT, "sched-999", { enabled: false }),
    ).rejects.toThrow(ScheduleNotFoundError);
  });

  it("throws ScheduleInvalidCronError when new cronExpr is invalid (6 fields)", async () => {
    scheduleRepo.findByIdWithTenant.mockResolvedValue(makeScheduleRow());

    await expect(
      service.updateSchedule(UUID_TENANT, "sched-001", { cronExpr: "0 0 * * * *" }),
    ).rejects.toThrow(ScheduleInvalidCronError);
  });

  it("updates cronExpr and recomputes nextRunAt when cronExpr changes", async () => {
    scheduleRepo.findByIdWithTenant.mockResolvedValue(makeScheduleRow());
    scheduleRepo.update.mockResolvedValue(makeScheduleRow({ cron_expr: "*/15 * * * *" }));

    await service.updateSchedule(UUID_TENANT, "sched-001", { cronExpr: "*/15 * * * *" });

    const updateArg = (scheduleRepo.update.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(updateArg["nextRunAt"]).toBeInstanceOf(Date);
  });

  it("recomputes nextRunAt when timezone changes", async () => {
    scheduleRepo.findByIdWithTenant.mockResolvedValue(makeScheduleRow());
    scheduleRepo.update.mockResolvedValue(makeScheduleRow({ timezone: "Europe/London" }));

    await service.updateSchedule(UUID_TENANT, "sched-001", { timezone: "Europe/London" });

    const updateArg = (scheduleRepo.update.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(updateArg["nextRunAt"]).toBeInstanceOf(Date);
  });

  it("does not recompute nextRunAt when only enabled changes", async () => {
    scheduleRepo.findByIdWithTenant.mockResolvedValue(makeScheduleRow());
    scheduleRepo.update.mockResolvedValue(makeScheduleRow({ enabled: false }));

    await service.updateSchedule(UUID_TENANT, "sched-001", { enabled: false });

    const updateArg = (scheduleRepo.update.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(updateArg["nextRunAt"]).toBeUndefined();
  });

  it("logs info message after successful update", async () => {
    scheduleRepo.findByIdWithTenant.mockResolvedValue(makeScheduleRow());
    scheduleRepo.update.mockResolvedValue(makeScheduleRow());

    await service.updateSchedule(UUID_TENANT, "sched-001", { enabled: false });

    const loggerInfo = logger.info as ReturnType<typeof vi.fn>;
    expect(loggerInfo).toHaveBeenCalledWith(
      "Schedule updated",
      expect.objectContaining({ tenantId: UUID_TENANT }),
    );
  });
});

// ---------------------------------------------------------------------------
// deleteSchedule
// ---------------------------------------------------------------------------

describe("deleteSchedule", () => {
  let scheduleRepo: MockScheduleRepo;
  let service: ScheduleService;
  let logger: Logger;

  beforeEach(() => {
    scheduleRepo = makeScheduleRepo();
    logger = makeLogger();
    service = createScheduleService({
      scheduleRepo: scheduleRepo as unknown as ScheduleRepository,
      pipelineRepo: makePipelineRepo(),
      runService: makeRunService() as unknown as RunService,
      logger,
    });
  });

  it("throws ScheduleNotFoundError when schedule does not exist", async () => {
    scheduleRepo.findByIdWithTenant.mockResolvedValue(null);

    await expect(service.deleteSchedule(UUID_TENANT, "sched-999")).rejects.toThrow(
      ScheduleNotFoundError,
    );
  });

  it("deletes schedule when it exists", async () => {
    scheduleRepo.findByIdWithTenant.mockResolvedValue(makeScheduleRow());
    scheduleRepo.delete.mockResolvedValue(undefined);

    await service.deleteSchedule(UUID_TENANT, "sched-001");

    expect(scheduleRepo.delete).toHaveBeenCalledWith(UUID_TENANT, "sched-001");
  });

  it("logs info message after successful deletion", async () => {
    scheduleRepo.findByIdWithTenant.mockResolvedValue(makeScheduleRow());
    scheduleRepo.delete.mockResolvedValue(undefined);

    await service.deleteSchedule(UUID_TENANT, "sched-001");

    const loggerInfo = logger.info as ReturnType<typeof vi.fn>;
    expect(loggerInfo).toHaveBeenCalledWith(
      "Schedule deleted",
      expect.objectContaining({ tenantId: UUID_TENANT }),
    );
  });

  it("does not call repo.delete when schedule is not found", async () => {
    scheduleRepo.findByIdWithTenant.mockResolvedValue(null);

    await expect(service.deleteSchedule(UUID_TENANT, "missing")).rejects.toThrow();
    expect(scheduleRepo.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// startCronLoop / stop
// ---------------------------------------------------------------------------

describe("startCronLoop and stop", () => {
  let scheduleRepo: MockScheduleRepo;
  let service: ScheduleService;
  let logger: Logger;

  beforeEach(() => {
    scheduleRepo = makeScheduleRepo();
    logger = makeLogger();
    scheduleRepo.findDueSchedules.mockResolvedValue([]);
    service = createScheduleService({
      scheduleRepo: scheduleRepo as unknown as ScheduleRepository,
      pipelineRepo: makePipelineRepo(),
      runService: makeRunService() as unknown as RunService,
      logger,
    });
  });

  afterEach(() => {
    service.stop();
    vi.useRealTimers();
  });

  it("startCronLoop is idempotent — calling twice does not double-schedule", () => {
    service.startCronLoop();
    service.startCronLoop(); // should be no-op

    const loggerInfo = logger.info as ReturnType<typeof vi.fn>;
    const startCalls = (loggerInfo.mock.calls as Array<unknown[]>).filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("started"),
    );
    // Only one log entry for "started" (idempotent)
    expect(startCalls.length).toBe(1);
  });

  it("stop sets stopped flag so subsequent ticks are no-ops", () => {
    service.startCronLoop();
    service.stop();

    const loggerInfo = logger.info as ReturnType<typeof vi.fn>;
    const stopCalls = (loggerInfo.mock.calls as Array<unknown[]>).filter(
      (c) => typeof c[0] === "string" && (c[0] as string).includes("stopped"),
    );
    expect(stopCalls.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// cronTick — due schedules triggering
// ---------------------------------------------------------------------------

describe("cronTick — due schedule triggering", () => {
  let scheduleRepo: MockScheduleRepo;
  let runService: MockRunService;
  let service: ScheduleService;
  let logger: Logger;

  beforeEach(() => {
    scheduleRepo = makeScheduleRepo();
    runService = makeRunService();
    logger = makeLogger();
    service = createScheduleService({
      scheduleRepo: scheduleRepo as unknown as ScheduleRepository,
      pipelineRepo: makePipelineRepo(),
      runService: runService as unknown as RunService,
      logger,
    });
  });

  afterEach(() => {
    service.stop();
  });

  it("triggers a run for each claimed due schedule", async () => {
    const dueSchedule = makeScheduleRow();
    scheduleRepo.findDueSchedules.mockResolvedValue([dueSchedule]);
    scheduleRepo.claimScheduleRun.mockResolvedValue(true);
    const triggerResult: TriggerRunResult = { runId: "run-001", status: "pending" };
    runService.triggerRun.mockResolvedValue(triggerResult);

    // Start loop which also triggers an initial tick
    service.startCronLoop();

    // Allow async tick to run
    await new Promise((resolve) => setTimeout(resolve, 50));
    service.stop();

    expect(runService.triggerRun).toHaveBeenCalledWith(
      dueSchedule.pipeline_id,
      dueSchedule.tenant_id,
      "schedule",
      dueSchedule.input_template,
      expect.any(Object),
      dueSchedule.id,
    );
  });

  it("skips schedule run when optimistic claim fails (another replica won)", async () => {
    const dueSchedule = makeScheduleRow();
    scheduleRepo.findDueSchedules.mockResolvedValue([dueSchedule]);
    scheduleRepo.claimScheduleRun.mockResolvedValue(false); // another replica claimed it

    service.startCronLoop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    service.stop();

    expect(runService.triggerRun).not.toHaveBeenCalled();
  });

  it("continues processing other schedules when one trigger fails", async () => {
    const schedA = makeScheduleRow({ id: "sched-a" });
    const schedB = makeScheduleRow({ id: "sched-b" });
    scheduleRepo.findDueSchedules.mockResolvedValue([schedA, schedB]);
    scheduleRepo.claimScheduleRun.mockResolvedValue(true);
    runService.triggerRun
      .mockRejectedValueOnce(new Error("trigger failed"))
      .mockResolvedValue({ runId: "run-002", status: "pending" as const });

    service.startCronLoop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    service.stop();

    // Despite first failure, second schedule should still be triggered
    expect(runService.triggerRun).toHaveBeenCalledTimes(2);
  });

  it("logs error when findDueSchedules fails and does not throw", async () => {
    scheduleRepo.findDueSchedules.mockRejectedValue(new Error("DB connection lost"));

    service.startCronLoop();
    await new Promise((resolve) => setTimeout(resolve, 50));
    service.stop();

    const loggerError = logger.error as ReturnType<typeof vi.fn>;
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining("failed to query due schedules"),
      expect.any(Object),
    );
  });
});

// ---------------------------------------------------------------------------
// computeNextRunAt — timezone handling
// ---------------------------------------------------------------------------

describe("computeNextRunAt timezone handling (via createSchedule)", () => {
  let scheduleRepo: MockScheduleRepo;
  let pipelineRepo: MockPipelineRepo & PipelineRepoShape;
  let service: ScheduleService;

  beforeEach(() => {
    scheduleRepo = makeScheduleRepo();
    pipelineRepo = makePipelineRepo();
    pipelineRepo.findById.mockResolvedValue(makePipelineRow());
    service = createScheduleService({
      scheduleRepo: scheduleRepo as unknown as ScheduleRepository,
      pipelineRepo,
      runService: makeRunService() as unknown as RunService,
      logger: makeLogger(),
    });
  });

  it("passes a nextRunAt Date in the future for UTC timezone", async () => {
    scheduleRepo.create.mockResolvedValue(makeScheduleRow());
    const now = new Date();

    await service.createSchedule(UUID_TENANT, {
      pipelineId: UUID_PIPELINE,
      cronExpr: "0 * * * *",
      timezone: "UTC",
      enabled: true,
      inputTemplate: {},
    });

    const createArg = (scheduleRepo.create.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    const nextRunAt = createArg["nextRunAt"] as Date;
    expect(nextRunAt.getTime()).toBeGreaterThan(now.getTime());
  });

  it("passes a nextRunAt Date in the future for America/New_York timezone", async () => {
    scheduleRepo.create.mockResolvedValue(makeScheduleRow());
    const now = new Date();

    await service.createSchedule(UUID_TENANT, {
      pipelineId: UUID_PIPELINE,
      cronExpr: "0 9 * * 1-5",
      timezone: "America/New_York",
      enabled: true,
      inputTemplate: {},
    });

    const createArg = (scheduleRepo.create.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    const nextRunAt = createArg["nextRunAt"] as Date;
    expect(nextRunAt.getTime()).toBeGreaterThan(now.getTime());
  });
});
