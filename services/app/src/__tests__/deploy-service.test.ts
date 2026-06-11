// Unit tests for services/deploy-service.ts
//
// Covers deployApp, rollbackApp, OAuth rollback on failure, and Redis events.
// fetch is globally mocked with vi.stubGlobal so no real HTTP calls are made.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createDeployService,
  type DeployService,
  type DeployServiceDeps,
} from "../services/deploy-service.js";
import {
  AppNotFoundError,
  AppBuildNotFoundError,
  AppBuildNotReadyError,
  AppBuildArtifactsExpiredError,
  AppOAuthClientRegistrationFailedError,
} from "../services/errors.js";
import type { AppRepository } from "../repositories/app-repository.js";
import type { DeploymentRepository } from "../repositories/deployment-repository.js";
import type { PermissionRepository } from "../repositories/permission-repository.js";
import type { Logger } from "@oneplatform/core";
import type { AppRow, BuildRow } from "../repositories/types.js";
import type { Redis } from "ioredis";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeAppRow(overrides?: Partial<AppRow>): AppRow {
  return {
    id:               "app-001",
    tenant_id:        "tenant-001",
    name:             "My App",
    slug:             "my-app",
    description:      null,
    access_mode:      "platform-user",
    current_build_id: null,
    allowed_modules:  ["react"],
    created_at:       new Date("2026-01-01T00:00:00Z"),
    updated_at:       new Date("2026-01-01T00:00:00Z"),
    created_by:       "user-001",
    deleted_at:       null,
    ...overrides,
  };
}

function makeBuildRow(overrides?: Partial<BuildRow>): BuildRow {
  return {
    id:             "build-001",
    app_id:         "app-001",
    version_number: 1,
    status:         "success",
    bundle_path:    "tenant-001/app-001/builds/build-001",
    error_message:  null,
    error_detail:   null,
    build_manifest: null,
    built_at:       new Date("2026-01-01T01:00:00Z"),
    built_by:       "user-001",
    created_at:     new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

type MockAppRepo = {
  findByTenantAndId: ReturnType<typeof vi.fn>;
  update:            ReturnType<typeof vi.fn>;
};

type MockBuildRepo = {
  findByAppAndId:       ReturnType<typeof vi.fn>;
  findLatestSuccessful: ReturnType<typeof vi.fn>;
};

type MockPermRepo = {
  upsertOAuthRegistration: ReturnType<typeof vi.fn>;
};

type MockRedis = {
  publish: ReturnType<typeof vi.fn>;
};

function makeAppRepo(): MockAppRepo {
  return {
    findByTenantAndId: vi.fn(),
    update:            vi.fn(),
  };
}

function makeBuildRepo(): MockBuildRepo {
  return {
    findByAppAndId:       vi.fn(),
    findLatestSuccessful: vi.fn(),
  };
}

function makePermRepo(): MockPermRepo {
  return { upsertOAuthRegistration: vi.fn() };
}

function makeRedis(): MockRedis {
  return { publish: vi.fn() };
}

function makeOkFetchResponse() {
  return {
    ok:   true,
    text: vi.fn().mockResolvedValue(""),
  };
}

function makeErrorFetchResponse(status: number, body = "Internal Server Error") {
  return {
    ok:   false,
    status,
    text: vi.fn().mockResolvedValue(body),
  };
}

function makeDeps(
  overrides?: Partial<{
    appRepo:   MockAppRepo;
    buildRepo: MockBuildRepo;
    permRepo:  MockPermRepo;
    redis:     MockRedis;
    logger:    Logger;
  }>,
): DeployServiceDeps {
  return {
    appRepo:        (overrides?.appRepo   ?? makeAppRepo())   as unknown as AppRepository,
    buildRepo:      (overrides?.buildRepo ?? makeBuildRepo()) as unknown as DeploymentRepository,
    permRepo:       (overrides?.permRepo  ?? makePermRepo())  as unknown as PermissionRepository,
    redis:          (overrides?.redis     ?? makeRedis())     as unknown as Redis,
    authServiceUrl: "http://auth-service",
    baseUrl:        "https://platform.example.com",
    logger:         overrides?.logger ?? makeLogger(),
  };
}

// ---------------------------------------------------------------------------
// deployApp
// ---------------------------------------------------------------------------

describe("deployApp", () => {
  let appRepo:   MockAppRepo;
  let buildRepo: MockBuildRepo;
  let permRepo:  MockPermRepo;
  let redis:     MockRedis;
  let logger:    Logger;
  let service:   DeployService;

  beforeEach(() => {
    appRepo   = makeAppRepo();
    buildRepo = makeBuildRepo();
    permRepo  = makePermRepo();
    redis     = makeRedis();
    logger    = makeLogger();
    service   = createDeployService(makeDeps({ appRepo, buildRepo, permRepo, redis, logger }));

    // Stub global fetch to return a success response for OAuth registration
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeOkFetchResponse()));
    permRepo.upsertOAuthRegistration.mockResolvedValue({});
    redis.publish.mockResolvedValue(1);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws AppNotFoundError when app does not exist", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(
      service.deployApp("tenant-001", "app-999", "user-001"),
    ).rejects.toThrow(AppNotFoundError);
  });

  it("deploys the latest successful build when buildId is not specified", async () => {
    const app   = makeAppRow();
    const build = makeBuildRow();
    appRepo.findByTenantAndId.mockResolvedValue(app);
    buildRepo.findLatestSuccessful.mockResolvedValue(build);
    appRepo.update.mockResolvedValue(makeAppRow({ current_build_id: "build-001" }));

    const result = await service.deployApp("tenant-001", "app-001", "user-001");

    expect(result.buildId).toBe("build-001");
    expect(buildRepo.findLatestSuccessful).toHaveBeenCalledWith("app-001");
  });

  it("deploys the specified build when buildId is provided", async () => {
    const app   = makeAppRow();
    const build = makeBuildRow({ id: "build-specific" });
    appRepo.findByTenantAndId.mockResolvedValue(app);
    buildRepo.findByAppAndId.mockResolvedValue(build);
    appRepo.update.mockResolvedValue(makeAppRow({ current_build_id: "build-specific" }));

    const result = await service.deployApp("tenant-001", "app-001", "user-001", "build-specific");

    expect(result.buildId).toBe("build-specific");
    expect(buildRepo.findByAppAndId).toHaveBeenCalledWith("app-001", "build-specific");
  });

  it("throws AppBuildNotFoundError when specified buildId does not exist", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    buildRepo.findByAppAndId.mockResolvedValue(null);

    await expect(
      service.deployApp("tenant-001", "app-001", "user-001", "build-missing"),
    ).rejects.toThrow(AppBuildNotFoundError);
  });

  it("throws AppBuildNotReadyError when no successful build exists", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    buildRepo.findLatestSuccessful.mockResolvedValue(null);

    await expect(
      service.deployApp("tenant-001", "app-001", "user-001"),
    ).rejects.toThrow(AppBuildNotReadyError);
  });

  it("throws AppBuildNotReadyError when specified build is not in success state", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    buildRepo.findByAppAndId.mockResolvedValue(makeBuildRow({ status: "failed" }));

    await expect(
      service.deployApp("tenant-001", "app-001", "user-001", "build-failed"),
    ).rejects.toThrow(AppBuildNotReadyError);
  });

  it("throws AppBuildArtifactsExpiredError when bundle_path is null", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    buildRepo.findByAppAndId.mockResolvedValue(makeBuildRow({ bundle_path: null }));

    await expect(
      service.deployApp("tenant-001", "app-001", "user-001", "build-expired"),
    ).rejects.toThrow(AppBuildArtifactsExpiredError);
  });

  it("swaps current_build_id pointer on successful deploy", async () => {
    const app   = makeAppRow({ current_build_id: "build-old" });
    const build = makeBuildRow({ id: "build-new" });
    appRepo.findByTenantAndId.mockResolvedValue(app);
    buildRepo.findLatestSuccessful.mockResolvedValue(build);
    appRepo.update.mockResolvedValue(makeAppRow({ current_build_id: "build-new" }));

    await service.deployApp("tenant-001", "app-001", "user-001");

    expect(appRepo.update).toHaveBeenCalledWith(
      "app-001",
      expect.objectContaining({ current_build_id: "build-new" }),
    );
  });

  it("returns previousBuildId from the app row before the swap", async () => {
    const app   = makeAppRow({ current_build_id: "build-old" });
    const build = makeBuildRow({ id: "build-new" });
    appRepo.findByTenantAndId.mockResolvedValue(app);
    buildRepo.findLatestSuccessful.mockResolvedValue(build);
    appRepo.update.mockResolvedValue(makeAppRow({ current_build_id: "build-new" }));

    const result = await service.deployApp("tenant-001", "app-001", "user-001");
    expect(result.previousBuildId).toBe("build-old");
  });

  it("publishes app.deployed event to Redis after deploy", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    buildRepo.findLatestSuccessful.mockResolvedValue(makeBuildRow());
    appRepo.update.mockResolvedValue(makeAppRow({ current_build_id: "build-001" }));

    await service.deployApp("tenant-001", "app-001", "user-001");

    expect(redis.publish).toHaveBeenCalledWith(
      "events:tenant-001:app.deployed",
      expect.stringContaining('"eventType":"app.deployed"'),
    );
  });

  it("logs info after successful deploy", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    buildRepo.findLatestSuccessful.mockResolvedValue(makeBuildRow());
    appRepo.update.mockResolvedValue(makeAppRow({ current_build_id: "build-001" }));

    await service.deployApp("tenant-001", "app-001", "user-001");

    const logInfo = logger.info as ReturnType<typeof vi.fn>;
    expect(logInfo).toHaveBeenCalledWith(
      "App deployed",
      expect.objectContaining({ tenantId: "tenant-001", appId: "app-001" }),
    );
  });

  it("rolls back current_build_id when OAuth registration fails", async () => {
    const app   = makeAppRow({ current_build_id: "build-prev" });
    const build = makeBuildRow({ id: "build-new" });
    appRepo.findByTenantAndId.mockResolvedValue(app);
    buildRepo.findLatestSuccessful.mockResolvedValue(build);
    appRepo.update.mockResolvedValue(makeAppRow({ current_build_id: "build-new" }));

    // Simulate OAuth failure
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeErrorFetchResponse(500)));

    await expect(
      service.deployApp("tenant-001", "app-001", "user-001"),
    ).rejects.toThrow(AppOAuthClientRegistrationFailedError);

    // Should have attempted to revert to previous build
    expect(appRepo.update).toHaveBeenCalledWith(
      "app-001",
      expect.objectContaining({ current_build_id: "build-prev" }),
    );
  });

  it("throws AppOAuthClientRegistrationFailedError when Auth Service returns non-ok", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    buildRepo.findLatestSuccessful.mockResolvedValue(makeBuildRow());
    appRepo.update.mockResolvedValue(makeAppRow({ current_build_id: "build-001" }));

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(makeErrorFetchResponse(503, "Service Unavailable")));

    await expect(
      service.deployApp("tenant-001", "app-001", "user-001"),
    ).rejects.toThrow(AppOAuthClientRegistrationFailedError);
  });

  it("result contains deployedAt as ISO 8601 string", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    buildRepo.findLatestSuccessful.mockResolvedValue(makeBuildRow());
    appRepo.update.mockResolvedValue(makeAppRow({ current_build_id: "build-001" }));

    const result = await service.deployApp("tenant-001", "app-001", "user-001");
    expect(() => new Date(result.deployedAt)).not.toThrow();
    expect(new Date(result.deployedAt).toISOString()).toBe(result.deployedAt);
  });

  it("includes wildcard domain redirect URI when OP_WILDCARD_DOMAIN is set", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    buildRepo.findLatestSuccessful.mockResolvedValue(makeBuildRow());
    appRepo.update.mockResolvedValue(makeAppRow({ current_build_id: "build-001" }));

    const fetchMock = vi.fn().mockResolvedValue(makeOkFetchResponse());
    vi.stubGlobal("fetch", fetchMock);
    process.env["OP_WILDCARD_DOMAIN"] = "example.com";

    await service.deployApp("tenant-001", "app-001", "user-001");

    // The fetch call is (url, RequestInit). The body is in RequestInit.body.
    const callArgs = fetchMock.mock.calls[0] as [string, RequestInit];
    const requestInit = callArgs[1];
    const callBody = JSON.parse(requestInit.body as string) as { redirectUris: string[] };

    const hasWildcard = callBody.redirectUris.some((uri) =>
      uri.includes("my-app.apps.example.com"),
    );
    expect(hasWildcard).toBe(true);

    delete process.env["OP_WILDCARD_DOMAIN"];
  });
});

// ---------------------------------------------------------------------------
// rollbackApp
// ---------------------------------------------------------------------------

describe("rollbackApp", () => {
  let appRepo:   MockAppRepo;
  let buildRepo: MockBuildRepo;
  let redis:     MockRedis;
  let logger:    Logger;
  let service:   DeployService;

  beforeEach(() => {
    appRepo   = makeAppRepo();
    buildRepo = makeBuildRepo();
    redis     = makeRedis();
    logger    = makeLogger();
    service   = createDeployService(makeDeps({ appRepo, buildRepo, redis, logger }));

    redis.publish.mockResolvedValue(1);
  });

  it("throws AppNotFoundError when app does not exist", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(
      service.rollbackApp("tenant-001", "app-999", "user-001", "build-001"),
    ).rejects.toThrow(AppNotFoundError);
  });

  it("throws AppBuildNotFoundError when target build does not exist", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    buildRepo.findByAppAndId.mockResolvedValue(null);

    await expect(
      service.rollbackApp("tenant-001", "app-001", "user-001", "build-missing"),
    ).rejects.toThrow(AppBuildNotFoundError);
  });

  it("throws AppBuildNotReadyError when target build is not successful", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    buildRepo.findByAppAndId.mockResolvedValue(makeBuildRow({ status: "failed" }));

    await expect(
      service.rollbackApp("tenant-001", "app-001", "user-001", "build-failed"),
    ).rejects.toThrow(AppBuildNotReadyError);
  });

  it("throws AppBuildArtifactsExpiredError when target build has no bundle_path", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    buildRepo.findByAppAndId.mockResolvedValue(makeBuildRow({ bundle_path: null }));

    await expect(
      service.rollbackApp("tenant-001", "app-001", "user-001", "build-purged"),
    ).rejects.toThrow(AppBuildArtifactsExpiredError);
  });

  it("updates current_build_id to the target build on successful rollback", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow({ current_build_id: "build-current" }));
    buildRepo.findByAppAndId.mockResolvedValue(makeBuildRow({ id: "build-old" }));
    appRepo.update.mockResolvedValue(makeAppRow({ current_build_id: "build-old" }));

    await service.rollbackApp("tenant-001", "app-001", "user-001", "build-old");

    expect(appRepo.update).toHaveBeenCalledWith("app-001", { current_build_id: "build-old" });
  });

  it("returns fromBuildId and toBuildId in the result", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow({ current_build_id: "build-current" }));
    buildRepo.findByAppAndId.mockResolvedValue(makeBuildRow({ id: "build-old" }));
    appRepo.update.mockResolvedValue(makeAppRow({ current_build_id: "build-old" }));

    const result = await service.rollbackApp("tenant-001", "app-001", "user-001", "build-old");

    expect(result.fromBuildId).toBe("build-current");
    expect(result.toBuildId).toBe("build-old");
  });

  it("publishes app.rolled_back event to Redis", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow({ current_build_id: "build-current" }));
    buildRepo.findByAppAndId.mockResolvedValue(makeBuildRow({ id: "build-old" }));
    appRepo.update.mockResolvedValue(makeAppRow({ current_build_id: "build-old" }));

    await service.rollbackApp("tenant-001", "app-001", "user-001", "build-old");

    expect(redis.publish).toHaveBeenCalledWith(
      "events:tenant-001:app.rolled_back",
      expect.stringContaining('"eventType":"app.rolled_back"'),
    );
  });

  it("logs info after successful rollback", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow({ current_build_id: "build-current" }));
    buildRepo.findByAppAndId.mockResolvedValue(makeBuildRow({ id: "build-old" }));
    appRepo.update.mockResolvedValue(makeAppRow({ current_build_id: "build-old" }));

    await service.rollbackApp("tenant-001", "app-001", "user-001", "build-old");

    const logInfo = logger.info as ReturnType<typeof vi.fn>;
    expect(logInfo).toHaveBeenCalledWith(
      "App rolled back",
      expect.objectContaining({ tenantId: "tenant-001", appId: "app-001" }),
    );
  });

  it("result contains rolledBackAt as ISO 8601 string", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow({ current_build_id: "build-current" }));
    buildRepo.findByAppAndId.mockResolvedValue(makeBuildRow({ id: "build-old" }));
    appRepo.update.mockResolvedValue(makeAppRow({ current_build_id: "build-old" }));

    const result = await service.rollbackApp("tenant-001", "app-001", "user-001", "build-old");

    expect(() => new Date(result.rolledBackAt)).not.toThrow();
    expect(new Date(result.rolledBackAt).toISOString()).toBe(result.rolledBackAt);
  });

  it("returns empty string for fromBuildId when app had no active build", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow({ current_build_id: null }));
    buildRepo.findByAppAndId.mockResolvedValue(makeBuildRow({ id: "build-old" }));
    appRepo.update.mockResolvedValue(makeAppRow({ current_build_id: "build-old" }));

    const result = await service.rollbackApp("tenant-001", "app-001", "user-001", "build-old");
    expect(result.fromBuildId).toBe("");
  });
});
