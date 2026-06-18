// Unit tests for services/app-version-service.ts — G-072
//
// Covers: version creation, listing, retrieval, restore, diff, auto-increment
// version numbers, the 100-version cap (prune), and error cases.
// All I/O dependencies are mocked with vi.fn() — no real database.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createAppVersionService,
  MAX_VERSIONS_PER_APP,
  type AppVersionService,
} from "../services/app-version-service.js";
import { AppNotFoundError, AppVersionNotFoundError } from "../services/errors.js";
import type { AppVersionRepository } from "../repositories/app-version-repository.js";
import type { VersionRepository } from "../repositories/version-repository.js";
import type { AppRepository } from "../repositories/app-repository.js";
import type { Logger } from "@oneplatform/core";
import type { AppVersionRow, AppRow } from "../repositories/types.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeLogger(): Logger {
  return {
    debug: vi.fn(),
    info:  vi.fn(),
    warn:  vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function makeAppRow(id = "app-001"): AppRow {
  return {
    id,
    tenant_id:        "tenant-001",
    name:             "Test App",
    slug:             "test-app",
    description:      null,
    access_mode:      "platform-user",
    current_build_id: null,
    allowed_modules:  [],
    created_at:       new Date("2026-01-01T00:00:00Z"),
    updated_at:       new Date("2026-01-01T00:00:00Z"),
    created_by:       "user-001",
    deleted_at:       null,
  };
}

function makeVersionRow(overrides?: Partial<AppVersionRow>): AppVersionRow {
  return {
    id:             "ver-001",
    app_id:         "app-001",
    version_number: 1,
    files_snapshot: { "/src/App.tsx": "export function App() {}" },
    message:        null,
    created_by:     "user-001",
    created_at:     new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

type MockAppVersionRepo = {
  create:                ReturnType<typeof vi.fn>;
  listByApp:             ReturnType<typeof vi.fn>;
  countByApp:            ReturnType<typeof vi.fn>;
  findByAppAndVersion:   ReturnType<typeof vi.fn>;
  pruneOldest:           ReturnType<typeof vi.fn>;
};

type MockFileRepo = {
  getAllFilesForBuild: ReturnType<typeof vi.fn>;
  create:             ReturnType<typeof vi.fn>;
  delete:             ReturnType<typeof vi.fn>;
};

type MockAppRepo = {
  findById: ReturnType<typeof vi.fn>;
};

function makeAppVersionRepo(): MockAppVersionRepo {
  return {
    create:              vi.fn(),
    listByApp:           vi.fn(),
    countByApp:          vi.fn(),
    findByAppAndVersion: vi.fn(),
    pruneOldest:         vi.fn().mockResolvedValue(0),
  };
}

function makeFileRepo(): MockFileRepo {
  return {
    getAllFilesForBuild: vi.fn(),
    create:             vi.fn(),
    delete:             vi.fn(),
  };
}

function makeAppRepo(): MockAppRepo {
  return {
    findById: vi.fn(),
  };
}

function makeDeps(overrides?: {
  appVersionRepo?: MockAppVersionRepo;
  fileRepo?:       MockFileRepo;
  appRepo?:        MockAppRepo;
  logger?:         Logger;
}) {
  return {
    appVersionRepo: (overrides?.appVersionRepo ?? makeAppVersionRepo()) as unknown as AppVersionRepository,
    fileRepo:       (overrides?.fileRepo       ?? makeFileRepo())       as unknown as VersionRepository,
    appRepo:        (overrides?.appRepo        ?? makeAppRepo())        as unknown as AppRepository,
    logger:         overrides?.logger ?? makeLogger(),
  };
}

// ---------------------------------------------------------------------------
// createVersion
// ---------------------------------------------------------------------------

describe("createVersion — happy path", () => {
  let appVersionRepo: MockAppVersionRepo;
  let fileRepo: MockFileRepo;
  let appRepo: MockAppRepo;
  let service: AppVersionService;

  beforeEach(() => {
    appVersionRepo = makeAppVersionRepo();
    fileRepo       = makeFileRepo();
    appRepo        = makeAppRepo();
    service        = createAppVersionService(makeDeps({ appVersionRepo, fileRepo, appRepo }));
  });

  it("returns the created version row", async () => {
    appRepo.findById.mockResolvedValue(makeAppRow());
    fileRepo.getAllFilesForBuild.mockResolvedValue([
      { path: "/src/App.tsx", content: "code" },
    ]);
    const expected = makeVersionRow();
    appVersionRepo.create.mockResolvedValue(expected);

    const result = await service.createVersion("app-001", "user-001");
    expect(result).toBe(expected);
  });

  it("passes files snapshot to repo.create", async () => {
    appRepo.findById.mockResolvedValue(makeAppRow());
    fileRepo.getAllFilesForBuild.mockResolvedValue([
      { path: "/a.ts", content: "aaa" },
      { path: "/b.ts", content: "bbb" },
    ]);
    appVersionRepo.create.mockResolvedValue(makeVersionRow());

    await service.createVersion("app-001", "user-001");

    const arg = (appVersionRepo.create.mock.calls[0] as unknown[])[0] as {
      files_snapshot: Record<string, string>;
    };
    expect(arg.files_snapshot).toEqual({ "/a.ts": "aaa", "/b.ts": "bbb" });
  });

  it("passes message when provided", async () => {
    appRepo.findById.mockResolvedValue(makeAppRow());
    fileRepo.getAllFilesForBuild.mockResolvedValue([]);
    appVersionRepo.create.mockResolvedValue(makeVersionRow());

    await service.createVersion("app-001", "user-001", "Initial release");

    const arg = (appVersionRepo.create.mock.calls[0] as unknown[])[0] as { message?: string };
    expect(arg.message).toBe("Initial release");
  });

  it("calls pruneOldest after create to enforce the 100-version cap", async () => {
    appRepo.findById.mockResolvedValue(makeAppRow());
    fileRepo.getAllFilesForBuild.mockResolvedValue([]);
    appVersionRepo.create.mockResolvedValue(makeVersionRow());

    await service.createVersion("app-001", "user-001");

    expect(appVersionRepo.pruneOldest).toHaveBeenCalledWith("app-001", MAX_VERSIONS_PER_APP);
  });

  it("logs when versions are pruned", async () => {
    const logger = makeLogger();
    const localDeps = makeDeps({ appVersionRepo, fileRepo, appRepo, logger });
    service = createAppVersionService(localDeps);

    appRepo.findById.mockResolvedValue(makeAppRow());
    fileRepo.getAllFilesForBuild.mockResolvedValue([]);
    appVersionRepo.create.mockResolvedValue(makeVersionRow());
    appVersionRepo.pruneOldest.mockResolvedValue(3);  // simulates 3 pruned

    await service.createVersion("app-001", "user-001");

    const logInfo = logger.info as ReturnType<typeof vi.fn>;
    const calls = logInfo.mock.calls as unknown[][];
    expect(calls.some((c) => String(c[0]).includes("Pruned"))).toBe(true);
  });
});

describe("createVersion — error cases", () => {
  it("throws AppNotFoundError when app does not exist", async () => {
    const appRepo = makeAppRepo();
    appRepo.findById.mockResolvedValue(null);
    const service = createAppVersionService(makeDeps({ appRepo }));

    await expect(service.createVersion("nonexistent", "user-001")).rejects.toThrow(
      AppNotFoundError
    );
  });
});

// ---------------------------------------------------------------------------
// listVersions
// ---------------------------------------------------------------------------

describe("listVersions", () => {
  let appVersionRepo: MockAppVersionRepo;
  let appRepo: MockAppRepo;
  let service: AppVersionService;

  beforeEach(() => {
    appVersionRepo = makeAppVersionRepo();
    appRepo        = makeAppRepo();
    service        = createAppVersionService(makeDeps({ appVersionRepo, appRepo }));
    appRepo.findById.mockResolvedValue(makeAppRow());
  });

  it("returns versions and total from repo", async () => {
    const rows = [makeVersionRow(), makeVersionRow({ id: "ver-002", version_number: 2 })];
    appVersionRepo.listByApp.mockResolvedValue(rows);
    appVersionRepo.countByApp.mockResolvedValue(2);

    const result = await service.listVersions("app-001", { limit: 20 });
    expect(result.versions).toHaveLength(2);
    expect(result.total).toBe(2);
  });

  it("returns nextCursor as null when fewer items than limit", async () => {
    appVersionRepo.listByApp.mockResolvedValue([makeVersionRow()]);
    appVersionRepo.countByApp.mockResolvedValue(1);

    const result = await service.listVersions("app-001", { limit: 20 });
    expect(result.nextCursor).toBeNull();
  });

  it("returns nextCursor as ISO string of last item when count equals limit", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeVersionRow({
        id:             `ver-${i}`,
        version_number: i + 1,
        created_at:     new Date(`2026-01-0${i + 1}T00:00:00Z`),
      })
    );
    appVersionRepo.listByApp.mockResolvedValue(rows);
    appVersionRepo.countByApp.mockResolvedValue(50);

    const result = await service.listVersions("app-001", { limit: 5 });
    expect(result.nextCursor).toBe(rows[4]!.created_at.toISOString());
  });

  it("throws AppNotFoundError when app does not exist", async () => {
    appRepo.findById.mockResolvedValue(null);

    await expect(service.listVersions("missing", { limit: 20 })).rejects.toThrow(AppNotFoundError);
  });

  it("passes cursor to repo when provided", async () => {
    appVersionRepo.listByApp.mockResolvedValue([]);
    appVersionRepo.countByApp.mockResolvedValue(0);

    await service.listVersions("app-001", { cursor: "2026-01-01T00:00:00.000Z", limit: 10 });

    expect(appVersionRepo.listByApp).toHaveBeenCalledWith(
      "app-001",
      expect.objectContaining({ cursor: "2026-01-01T00:00:00.000Z" })
    );
  });
});

// ---------------------------------------------------------------------------
// getVersion
// ---------------------------------------------------------------------------

describe("getVersion", () => {
  let appVersionRepo: MockAppVersionRepo;
  let appRepo: MockAppRepo;
  let service: AppVersionService;

  beforeEach(() => {
    appVersionRepo = makeAppVersionRepo();
    appRepo        = makeAppRepo();
    service        = createAppVersionService(makeDeps({ appVersionRepo, appRepo }));
    appRepo.findById.mockResolvedValue(makeAppRow());
  });

  it("returns the version row when found", async () => {
    const row = makeVersionRow({ version_number: 3 });
    appVersionRepo.findByAppAndVersion.mockResolvedValue(row);

    const result = await service.getVersion("app-001", 3);
    expect(result).toBe(row);
  });

  it("throws AppVersionNotFoundError when version does not exist", async () => {
    appVersionRepo.findByAppAndVersion.mockResolvedValue(null);

    await expect(service.getVersion("app-001", 99)).rejects.toThrow(AppVersionNotFoundError);
  });

  it("throws AppNotFoundError when app does not exist", async () => {
    appRepo.findById.mockResolvedValue(null);

    await expect(service.getVersion("missing", 1)).rejects.toThrow(AppNotFoundError);
  });

  it("passes correct versionNumber to repo", async () => {
    appVersionRepo.findByAppAndVersion.mockResolvedValue(makeVersionRow({ version_number: 7 }));

    await service.getVersion("app-001", 7);

    expect(appVersionRepo.findByAppAndVersion).toHaveBeenCalledWith("app-001", 7);
  });
});

// ---------------------------------------------------------------------------
// restoreVersion
// ---------------------------------------------------------------------------

describe("restoreVersion", () => {
  let appVersionRepo: MockAppVersionRepo;
  let fileRepo: MockFileRepo;
  let appRepo: MockAppRepo;
  let service: AppVersionService;

  beforeEach(() => {
    appVersionRepo = makeAppVersionRepo();
    fileRepo       = makeFileRepo();
    appRepo        = makeAppRepo();
    service        = createAppVersionService(makeDeps({ appVersionRepo, fileRepo, appRepo }));
    appRepo.findById.mockResolvedValue(makeAppRow());
  });

  it("deletes all current files before writing restored files", async () => {
    const snapshot = { "/a.ts": "old a", "/b.ts": "old b" };
    appVersionRepo.findByAppAndVersion.mockResolvedValue(makeVersionRow({ files_snapshot: snapshot }));
    fileRepo.getAllFilesForBuild.mockResolvedValue([
      { path: "/a.ts", content: "current a" },
      { path: "/c.ts", content: "current c" },
    ]);
    fileRepo.create.mockResolvedValue({ path: "/a.ts", content: "old a" });
    // For the auto-version after restore
    const restoreVersionRow = makeVersionRow({ version_number: 2 });
    appVersionRepo.create.mockResolvedValue(restoreVersionRow);

    await service.restoreVersion("app-001", 1, "user-001");

    // Should have deleted both current files
    expect(fileRepo.delete).toHaveBeenCalledWith("app-001", "/a.ts");
    expect(fileRepo.delete).toHaveBeenCalledWith("app-001", "/c.ts");
  });

  it("writes all files from the snapshot", async () => {
    const snapshot = { "/src/App.tsx": "const App = () => null;" };
    appVersionRepo.findByAppAndVersion.mockResolvedValue(makeVersionRow({ files_snapshot: snapshot }));
    fileRepo.getAllFilesForBuild.mockResolvedValue([]);
    fileRepo.create.mockResolvedValue({ path: "/src/App.tsx", content: snapshot["/src/App.tsx"] });
    appVersionRepo.create.mockResolvedValue(makeVersionRow({ version_number: 2 }));

    await service.restoreVersion("app-001", 1, "user-001");

    expect(fileRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ path: "/src/App.tsx", content: snapshot["/src/App.tsx"] })
    );
  });

  it("creates a new version after restore with restore message", async () => {
    const snapshot = { "/a.ts": "aaa" };
    appVersionRepo.findByAppAndVersion.mockResolvedValue(makeVersionRow({ files_snapshot: snapshot, version_number: 3 }));
    fileRepo.getAllFilesForBuild.mockResolvedValue([]);
    fileRepo.create.mockResolvedValue({ path: "/a.ts", content: "aaa" });
    appVersionRepo.create.mockResolvedValue(makeVersionRow({ version_number: 4 }));

    await service.restoreVersion("app-001", 3, "user-001");

    const createArg = (appVersionRepo.create.mock.calls[0] as unknown[])[0] as { message?: string };
    expect(createArg.message).toContain("Restored from version 3");
  });

  it("returns correct RestoreResult shape", async () => {
    const snapshot = { "/a.ts": "aaa" };
    appVersionRepo.findByAppAndVersion.mockResolvedValue(makeVersionRow({ files_snapshot: snapshot, version_number: 5 }));
    fileRepo.getAllFilesForBuild.mockResolvedValue([]);
    fileRepo.create.mockResolvedValue({ path: "/a.ts", content: "aaa" });
    appVersionRepo.create.mockResolvedValue(makeVersionRow({ version_number: 6 }));

    const result = await service.restoreVersion("app-001", 5, "user-001");

    expect(result.restoredFromVersionNumber).toBe(5);
    expect(result.newVersionNumber).toBe(6);
    expect(result.fileCount).toBe(1);
  });

  it("throws AppVersionNotFoundError when target version does not exist", async () => {
    appVersionRepo.findByAppAndVersion.mockResolvedValue(null);

    await expect(service.restoreVersion("app-001", 99, "user-001")).rejects.toThrow(
      AppVersionNotFoundError
    );
  });
});

// ---------------------------------------------------------------------------
// diffVersions
// ---------------------------------------------------------------------------

describe("diffVersions", () => {
  let appVersionRepo: MockAppVersionRepo;
  let appRepo: MockAppRepo;
  let service: AppVersionService;

  beforeEach(() => {
    appVersionRepo = makeAppVersionRepo();
    appRepo        = makeAppRepo();
    service        = createAppVersionService(makeDeps({ appVersionRepo, appRepo }));
    appRepo.findById.mockResolvedValue(makeAppRow());
  });

  it("returns empty diff for two identical versions", async () => {
    const snapshot = { "/a.ts": "same content" };
    appVersionRepo.findByAppAndVersion
      .mockResolvedValueOnce(makeVersionRow({ version_number: 1, files_snapshot: snapshot }))
      .mockResolvedValueOnce(makeVersionRow({ version_number: 2, files_snapshot: snapshot }));

    const diff = await service.diffVersions("app-001", 1, 2);

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.modified).toHaveLength(0);
  });

  it("detects added files between versions", async () => {
    appVersionRepo.findByAppAndVersion
      .mockResolvedValueOnce(makeVersionRow({ files_snapshot: { "/a.ts": "a" } }))
      .mockResolvedValueOnce(makeVersionRow({ files_snapshot: { "/a.ts": "a", "/b.ts": "b" } }));

    const diff = await service.diffVersions("app-001", 1, 2);

    expect(diff.added).toContain("/b.ts");
  });

  it("detects removed files between versions", async () => {
    appVersionRepo.findByAppAndVersion
      .mockResolvedValueOnce(makeVersionRow({ files_snapshot: { "/a.ts": "a", "/b.ts": "b" } }))
      .mockResolvedValueOnce(makeVersionRow({ files_snapshot: { "/a.ts": "a" } }));

    const diff = await service.diffVersions("app-001", 1, 2);

    expect(diff.removed).toContain("/b.ts");
  });

  it("detects modified files between versions", async () => {
    appVersionRepo.findByAppAndVersion
      .mockResolvedValueOnce(makeVersionRow({ files_snapshot: { "/a.ts": "old content" } }))
      .mockResolvedValueOnce(makeVersionRow({ files_snapshot: { "/a.ts": "new content" } }));

    const diff = await service.diffVersions("app-001", 1, 2);

    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0]!.path).toBe("/a.ts");
  });

  it("throws AppVersionNotFoundError when fromVersion does not exist", async () => {
    appVersionRepo.findByAppAndVersion
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeVersionRow({ version_number: 2 }));

    await expect(service.diffVersions("app-001", 1, 2)).rejects.toThrow(AppVersionNotFoundError);
  });

  it("throws AppVersionNotFoundError when toVersion does not exist", async () => {
    appVersionRepo.findByAppAndVersion
      .mockResolvedValueOnce(makeVersionRow({ version_number: 1 }))
      .mockResolvedValueOnce(null);

    await expect(service.diffVersions("app-001", 1, 99)).rejects.toThrow(AppVersionNotFoundError);
  });

  it("throws AppNotFoundError when app does not exist", async () => {
    appRepo.findById.mockResolvedValue(null);

    await expect(service.diffVersions("missing", 1, 2)).rejects.toThrow(AppNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// MAX_VERSIONS_PER_APP constant
// ---------------------------------------------------------------------------

describe("MAX_VERSIONS_PER_APP", () => {
  it("is 100", () => {
    expect(MAX_VERSIONS_PER_APP).toBe(100);
  });
});
