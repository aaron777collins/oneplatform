// Unit tests for services/app-service.ts
//
// Covers createApp, getApp, listApps, updateApp, deleteApp,
// validateFilePath, and sha256hex. All I/O dependencies are vi.fn() mocks.

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createAppService,
  validateFilePath,
  sha256hex,
  type AppService,
  type AppServiceDeps,
} from "../services/app-service.js";
import {
  AppNotFoundError,
  AppSlugConflictError,
  AppFileInvalidPathError,
} from "../services/errors.js";
import type { AppRepository } from "../repositories/app-repository.js";
import type { VersionRepository } from "../repositories/version-repository.js";
import type { Logger } from "@oneplatform/core";
import type { AppRow } from "../repositories/types.js";

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
    allowed_modules:  ["react", "react-dom"],
    created_at:       new Date("2026-01-01T00:00:00Z"),
    updated_at:       new Date("2026-01-01T00:00:00Z"),
    created_by:       "user-001",
    deleted_at:       null,
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
  create:               ReturnType<typeof vi.fn>;
  findById:             ReturnType<typeof vi.fn>;
  findByTenantAndId:    ReturnType<typeof vi.fn>;
  findByTenantAndSlug:  ReturnType<typeof vi.fn>;
  findPublicBySlug:     ReturnType<typeof vi.fn>;
  findByTenantId:       ReturnType<typeof vi.fn>;
  countByTenantId:      ReturnType<typeof vi.fn>;
  update:               ReturnType<typeof vi.fn>;
  softDelete:           ReturnType<typeof vi.fn>;
};

type MockFileRepo = {
  create:    ReturnType<typeof vi.fn>;
};

function makeAppRepo(): MockAppRepo {
  return {
    create:              vi.fn(),
    findById:            vi.fn(),
    findByTenantAndId:   vi.fn(),
    findByTenantAndSlug: vi.fn(),
    findPublicBySlug:    vi.fn(),
    findByTenantId:      vi.fn(),
    countByTenantId:     vi.fn(),
    update:              vi.fn(),
    softDelete:          vi.fn(),
  };
}

function makeFileRepo(): MockFileRepo {
  return {
    create: vi.fn().mockResolvedValue(null),
  };
}

function makeDeps(
  overrides?: Partial<{
    appRepo:  MockAppRepo;
    fileRepo: MockFileRepo;
    logger:   Logger;
  }>,
): AppServiceDeps {
  return {
    appRepo:  (overrides?.appRepo  ?? makeAppRepo())  as unknown as AppRepository,
    fileRepo: (overrides?.fileRepo ?? makeFileRepo()) as unknown as VersionRepository,
    logger:   overrides?.logger ?? makeLogger(),
  };
}

// ---------------------------------------------------------------------------
// validateFilePath — pure function, no I/O
// ---------------------------------------------------------------------------

describe("validateFilePath — valid paths", () => {
  it("accepts /src/index.tsx", () => {
    expect(() => validateFilePath("/src/index.tsx")).not.toThrow();
  });

  it("accepts /src/App.tsx", () => {
    expect(() => validateFilePath("/src/App.tsx")).not.toThrow();
  });

  it("accepts /package.json", () => {
    expect(() => validateFilePath("/package.json")).not.toThrow();
  });

  it("accepts /tsconfig.json", () => {
    expect(() => validateFilePath("/tsconfig.json")).not.toThrow();
  });

  it("accepts /styles/main.css", () => {
    expect(() => validateFilePath("/styles/main.css")).not.toThrow();
  });

  it("accepts /README.md", () => {
    expect(() => validateFilePath("/README.md")).not.toThrow();
  });

  it("accepts /public/index.html", () => {
    expect(() => validateFilePath("/public/index.html")).not.toThrow();
  });

  it("accepts /assets/logo.svg", () => {
    expect(() => validateFilePath("/assets/logo.svg")).not.toThrow();
  });

  it("accepts /utils/helpers.js", () => {
    expect(() => validateFilePath("/utils/helpers.js")).not.toThrow();
  });

  it("accepts a path of exactly 512 chars", () => {
    const longPath = "/" + "a".repeat(507) + ".tsx";
    expect(longPath.length).toBe(512);
    expect(() => validateFilePath(longPath)).not.toThrow();
  });
});

describe("validateFilePath — invalid paths", () => {
  it("rejects path not starting with /", () => {
    expect(() => validateFilePath("src/index.tsx")).toThrow(AppFileInvalidPathError);
  });

  it("rejects path containing .. (traversal)", () => {
    expect(() => validateFilePath("/src/../secret.tsx")).toThrow(AppFileInvalidPathError);
  });

  it("rejects path exceeding 512 chars", () => {
    const longPath = "/" + "a".repeat(508) + ".tsx";
    expect(longPath.length).toBe(513);
    expect(() => validateFilePath(longPath)).toThrow(AppFileInvalidPathError);
  });

  it("rejects path with null byte", () => {
    expect(() => validateFilePath("/src/\x00evil.tsx")).toThrow(AppFileInvalidPathError);
  });

  it("rejects path with newline character", () => {
    expect(() => validateFilePath("/src/\nmalicious.tsx")).toThrow(AppFileInvalidPathError);
  });

  it("rejects path with carriage return", () => {
    expect(() => validateFilePath("/src/\rmalicious.tsx")).toThrow(AppFileInvalidPathError);
  });

  it("rejects path with DEL character (0x7f)", () => {
    expect(() => validateFilePath("/src/\x7ffile.tsx")).toThrow(AppFileInvalidPathError);
  });

  it("rejects .py extension (not in allowlist)", () => {
    expect(() => validateFilePath("/src/script.py")).toThrow(AppFileInvalidPathError);
  });

  it("rejects .sh extension", () => {
    expect(() => validateFilePath("/scripts/deploy.sh")).toThrow(AppFileInvalidPathError);
  });

  it("rejects .env extension", () => {
    expect(() => validateFilePath("/.env")).toThrow(AppFileInvalidPathError);
  });

  it("rejects no extension", () => {
    expect(() => validateFilePath("/Makefile")).toThrow(AppFileInvalidPathError);
  });

  it("throws AppFileInvalidPathError (not plain Error)", () => {
    try {
      validateFilePath("relative/path.tsx");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AppFileInvalidPathError);
    }
  });

  it("traversal error has code APP_FILE_INVALID_PATH", () => {
    try {
      validateFilePath("/a/../b.tsx");
      expect.fail("should have thrown");
    } catch (e) {
      if (e instanceof AppFileInvalidPathError) {
        expect(e.code).toBe("APP_FILE_INVALID_PATH");
      } else {
        throw e;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// sha256hex — pure function
// ---------------------------------------------------------------------------

describe("sha256hex", () => {
  it("returns a 64-char hex string for a non-empty input", () => {
    const hash = sha256hex("hello world");
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it("produces known hash for empty string", () => {
    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const hash = sha256hex("");
    expect(hash).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("is deterministic — same input produces same output", () => {
    const h1 = sha256hex("test content");
    const h2 = sha256hex("test content");
    expect(h1).toBe(h2);
  });

  it("different inputs produce different hashes", () => {
    const h1 = sha256hex("content A");
    const h2 = sha256hex("content B");
    expect(h1).not.toBe(h2);
  });

  it("is case-sensitive — uppercase differs from lowercase", () => {
    const h1 = sha256hex("Content");
    const h2 = sha256hex("content");
    expect(h1).not.toBe(h2);
  });

  it("handles Unicode content", () => {
    const hash = sha256hex("日本語テスト");
    expect(hash).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------
// createApp
// ---------------------------------------------------------------------------

describe("createApp", () => {
  let appRepo: MockAppRepo;
  let fileRepo: MockFileRepo;
  let logger: Logger;
  let service: AppService;

  beforeEach(() => {
    appRepo  = makeAppRepo();
    fileRepo = makeFileRepo();
    logger   = makeLogger();
    service  = createAppService(makeDeps({ appRepo, fileRepo, logger }));
  });

  it("creates a platform-user app and returns the row from the repo", async () => {
    const expectedRow = makeAppRow();
    appRepo.findByTenantAndSlug.mockResolvedValue(null);
    appRepo.create.mockResolvedValue(expectedRow);

    const result = await service.createApp("tenant-001", "user-001", {
      name:       "My App",
      slug:       "my-app",
      accessMode: "platform-user",
    });

    expect(result).toBe(expectedRow);
    expect(appRepo.create).toHaveBeenCalledOnce();
  });

  it("creates a public app after checking global slug uniqueness", async () => {
    const expectedRow = makeAppRow({ access_mode: "public" });
    appRepo.findPublicBySlug.mockResolvedValue(null);
    appRepo.create.mockResolvedValue(expectedRow);

    await service.createApp("tenant-001", "user-001", {
      name:       "Public App",
      slug:       "public-app",
      accessMode: "public",
    });

    expect(appRepo.findPublicBySlug).toHaveBeenCalledWith("public-app");
    expect(appRepo.findByTenantAndSlug).not.toHaveBeenCalled();
  });

  it("throws AppSlugConflictError when slug is taken for platform-user app", async () => {
    appRepo.findByTenantAndSlug.mockResolvedValue(makeAppRow());

    await expect(
      service.createApp("tenant-001", "user-001", {
        name:       "My App",
        slug:       "my-app",
        accessMode: "platform-user",
      }),
    ).rejects.toThrow(AppSlugConflictError);
  });

  it("throws AppSlugConflictError when public slug is already taken globally", async () => {
    appRepo.findPublicBySlug.mockResolvedValue(makeAppRow({ access_mode: "public" }));

    await expect(
      service.createApp("tenant-001", "user-001", {
        name:       "Public App",
        slug:       "taken-slug",
        accessMode: "public",
      }),
    ).rejects.toThrow(AppSlugConflictError);
  });

  it("seeds default VFS template files after creation", async () => {
    appRepo.findByTenantAndSlug.mockResolvedValue(null);
    appRepo.create.mockResolvedValue(makeAppRow());

    await service.createApp("tenant-001", "user-001", {
      name:       "My App",
      slug:       "my-app",
      accessMode: "platform-user",
    });

    // Template has 4 files: /package.json, /tsconfig.json, /src/index.tsx, /src/App.tsx
    expect(fileRepo.create).toHaveBeenCalledTimes(4);
  });

  it("seeds /src/index.tsx in the VFS template", async () => {
    appRepo.findByTenantAndSlug.mockResolvedValue(null);
    appRepo.create.mockResolvedValue(makeAppRow());

    await service.createApp("tenant-001", "user-001", {
      name:       "My App",
      slug:       "my-app",
      accessMode: "platform-user",
    });

    const calls = fileRepo.create.mock.calls as unknown[][];
    const paths = calls.map((c) => (c[0] as { path: string }).path);
    expect(paths).toContain("/src/index.tsx");
  });

  it("seeds /src/App.tsx in the VFS template", async () => {
    appRepo.findByTenantAndSlug.mockResolvedValue(null);
    appRepo.create.mockResolvedValue(makeAppRow());

    await service.createApp("tenant-001", "user-001", {
      name:       "My App",
      slug:       "my-app",
      accessMode: "platform-user",
    });

    const calls = fileRepo.create.mock.calls as unknown[][];
    const paths = calls.map((c) => (c[0] as { path: string }).path);
    expect(paths).toContain("/src/App.tsx");
  });

  it("passes description to repo when provided", async () => {
    appRepo.findByTenantAndSlug.mockResolvedValue(null);
    appRepo.create.mockResolvedValue(makeAppRow({ description: "A great app" }));

    await service.createApp("tenant-001", "user-001", {
      name:        "My App",
      slug:        "my-app",
      accessMode:  "platform-user",
      description: "A great app",
    });

    const createArg = (appRepo.create.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(createArg["description"]).toBe("A great app");
  });

  it("logs info after successful creation", async () => {
    appRepo.findByTenantAndSlug.mockResolvedValue(null);
    appRepo.create.mockResolvedValue(makeAppRow());

    await service.createApp("tenant-001", "user-001", {
      name:       "My App",
      slug:       "my-app",
      accessMode: "platform-user",
    });

    const logInfo = logger.info as ReturnType<typeof vi.fn>;
    expect(logInfo).toHaveBeenCalledWith(
      "App created with default template",
      expect.objectContaining({ tenantId: "tenant-001" }),
    );
  });

  it("does not call repo.create when slug conflict is detected", async () => {
    appRepo.findByTenantAndSlug.mockResolvedValue(makeAppRow());

    await expect(
      service.createApp("t", "u", { name: "x", slug: "taken", accessMode: "platform-user" }),
    ).rejects.toThrow();

    expect(appRepo.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getApp
// ---------------------------------------------------------------------------

describe("getApp", () => {
  let appRepo: MockAppRepo;
  let service: AppService;

  beforeEach(() => {
    appRepo = makeAppRepo();
    service = createAppService(makeDeps({ appRepo }));
  });

  it("returns the app row when found", async () => {
    const row = makeAppRow();
    appRepo.findByTenantAndId.mockResolvedValue(row);

    const result = await service.getApp("tenant-001", "app-001");
    expect(result).toBe(row);
  });

  it("throws AppNotFoundError when app does not exist", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(service.getApp("tenant-001", "app-999")).rejects.toThrow(AppNotFoundError);
  });

  it("passes tenantId and id to findByTenantAndId", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(service.getApp("tenant-001", "app-xyz")).rejects.toThrow();
    expect(appRepo.findByTenantAndId).toHaveBeenCalledWith("tenant-001", "app-xyz");
  });

  it("does not leak existence across tenants — same behaviour for wrong tenant", async () => {
    // The repo returns null for wrong tenant — same 404 response
    appRepo.findByTenantAndId.mockResolvedValue(null);
    await expect(service.getApp("tenant-attacker", "app-001")).rejects.toThrow(AppNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// listApps
// ---------------------------------------------------------------------------

describe("listApps", () => {
  let appRepo: MockAppRepo;
  let service: AppService;

  beforeEach(() => {
    appRepo = makeAppRepo();
    service = createAppService(makeDeps({ appRepo }));
  });

  it("returns apps array and total from repo", async () => {
    const rows = [makeAppRow()];
    appRepo.findByTenantId.mockResolvedValue(rows);
    appRepo.countByTenantId.mockResolvedValue(1);

    const result = await service.listApps("tenant-001");
    expect(result.apps).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it("returns nextCursor as null when result count is less than limit", async () => {
    appRepo.findByTenantId.mockResolvedValue([makeAppRow()]);
    appRepo.countByTenantId.mockResolvedValue(1);

    const result = await service.listApps("tenant-001", { limit: 50 });
    expect(result.nextCursor).toBeNull();
  });

  it("returns nextCursor as last row id when result count equals limit", async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      makeAppRow({ id: `app-${String(i).padStart(3, "0")}` }),
    );
    appRepo.findByTenantId.mockResolvedValue(rows);
    appRepo.countByTenantId.mockResolvedValue(100);

    const result = await service.listApps("tenant-001", { limit: 10 });
    expect(result.nextCursor).toBe("app-009");
  });

  it("passes cursor to repo when provided", async () => {
    appRepo.findByTenantId.mockResolvedValue([]);
    appRepo.countByTenantId.mockResolvedValue(0);

    await service.listApps("tenant-001", { cursor: "cursor-xyz", limit: 20 });

    expect(appRepo.findByTenantId).toHaveBeenCalledWith(
      "tenant-001",
      expect.objectContaining({ cursor: "cursor-xyz", limit: 20 }),
    );
  });

  it("defaults limit to 50 when not provided", async () => {
    appRepo.findByTenantId.mockResolvedValue([]);
    appRepo.countByTenantId.mockResolvedValue(0);

    await service.listApps("tenant-001");

    expect(appRepo.findByTenantId).toHaveBeenCalledWith(
      "tenant-001",
      expect.objectContaining({ limit: 50 }),
    );
  });

  it("returns empty apps array when no apps exist", async () => {
    appRepo.findByTenantId.mockResolvedValue([]);
    appRepo.countByTenantId.mockResolvedValue(0);

    const result = await service.listApps("tenant-001");
    expect(result.apps).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.nextCursor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// updateApp
// ---------------------------------------------------------------------------

describe("updateApp", () => {
  let appRepo: MockAppRepo;
  let logger: Logger;
  let service: AppService;

  beforeEach(() => {
    appRepo = makeAppRepo();
    logger  = makeLogger();
    service = createAppService(makeDeps({ appRepo, logger }));
  });

  it("throws AppNotFoundError when app does not exist", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(
      service.updateApp("tenant-001", "app-999", { name: "New Name" }),
    ).rejects.toThrow(AppNotFoundError);
  });

  it("updates app name and returns updated row", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    appRepo.update.mockResolvedValue(makeAppRow({ name: "Updated Name" }));

    const result = await service.updateApp("tenant-001", "app-001", { name: "Updated Name" });
    expect(result.name).toBe("Updated Name");
  });

  it("checks tenant slug uniqueness when slug is changing for platform-user app", async () => {
    const existingApp = makeAppRow({ slug: "old-slug" });
    appRepo.findByTenantAndId.mockResolvedValue(existingApp);
    appRepo.findByTenantAndSlug.mockResolvedValue(null);
    appRepo.update.mockResolvedValue(makeAppRow({ slug: "new-slug" }));

    await service.updateApp("tenant-001", "app-001", { slug: "new-slug" });

    expect(appRepo.findByTenantAndSlug).toHaveBeenCalledWith("tenant-001", "new-slug");
  });

  it("throws AppSlugConflictError when new slug is already taken by another app", async () => {
    const existingApp = makeAppRow({ slug: "old-slug" });
    const conflictingApp = makeAppRow({ id: "app-other", slug: "taken-slug" });
    appRepo.findByTenantAndId.mockResolvedValue(existingApp);
    appRepo.findByTenantAndSlug.mockResolvedValue(conflictingApp);

    await expect(
      service.updateApp("tenant-001", "app-001", { slug: "taken-slug" }),
    ).rejects.toThrow(AppSlugConflictError);
  });

  it("allows slug update to same slug (idempotent — no conflict check needed)", async () => {
    const existingApp = makeAppRow({ slug: "my-app" });
    appRepo.findByTenantAndId.mockResolvedValue(existingApp);
    appRepo.update.mockResolvedValue(existingApp);

    // Same slug — findByTenantAndSlug should not be called because slug hasn't changed
    await service.updateApp("tenant-001", "app-001", { slug: "my-app" });

    expect(appRepo.findByTenantAndSlug).not.toHaveBeenCalled();
  });

  it("checks public slug uniqueness when switching to public access mode", async () => {
    const existingApp = makeAppRow({ access_mode: "platform-user", slug: "my-app" });
    appRepo.findByTenantAndId.mockResolvedValue(existingApp);
    appRepo.findPublicBySlug.mockResolvedValue(null);
    appRepo.update.mockResolvedValue(makeAppRow({ access_mode: "public", slug: "new-pub-slug" }));

    await service.updateApp("tenant-001", "app-001", {
      slug:       "new-pub-slug",
      accessMode: "public",
    });

    expect(appRepo.findPublicBySlug).toHaveBeenCalledWith("new-pub-slug");
  });

  it("throws AppNotFoundError when repo.update returns null (race condition)", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    appRepo.update.mockResolvedValue(null);

    await expect(
      service.updateApp("tenant-001", "app-001", { name: "Updated" }),
    ).rejects.toThrow(AppNotFoundError);
  });

  it("logs info after successful update", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    appRepo.update.mockResolvedValue(makeAppRow());

    await service.updateApp("tenant-001", "app-001", { name: "Updated" });

    const logInfo = logger.info as ReturnType<typeof vi.fn>;
    expect(logInfo).toHaveBeenCalledWith(
      "App updated",
      expect.objectContaining({ tenantId: "tenant-001", appId: "app-001" }),
    );
  });

  it("does not call repo.update when app is not found", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(service.updateApp("t", "missing", { name: "x" })).rejects.toThrow();
    expect(appRepo.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// deleteApp
// ---------------------------------------------------------------------------

describe("deleteApp", () => {
  let appRepo: MockAppRepo;
  let logger: Logger;
  let service: AppService;

  beforeEach(() => {
    appRepo = makeAppRepo();
    logger  = makeLogger();
    service = createAppService(makeDeps({ appRepo, logger }));
  });

  it("throws AppNotFoundError when app does not exist", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(service.deleteApp("tenant-001", "app-999")).rejects.toThrow(AppNotFoundError);
  });

  it("soft-deletes the app when found", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    appRepo.softDelete.mockResolvedValue(true);

    await service.deleteApp("tenant-001", "app-001");

    expect(appRepo.softDelete).toHaveBeenCalledWith("app-001");
  });

  it("logs info after successful deletion", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(makeAppRow());
    appRepo.softDelete.mockResolvedValue(true);

    await service.deleteApp("tenant-001", "app-001");

    const logInfo = logger.info as ReturnType<typeof vi.fn>;
    expect(logInfo).toHaveBeenCalledWith(
      "App soft-deleted",
      expect.objectContaining({ tenantId: "tenant-001", appId: "app-001" }),
    );
  });

  it("does not call softDelete when app is not found", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(service.deleteApp("t", "missing")).rejects.toThrow();
    expect(appRepo.softDelete).not.toHaveBeenCalled();
  });

  it("calls findByTenantAndId with correct tenantId (tenant isolation)", async () => {
    appRepo.findByTenantAndId.mockResolvedValue(null);

    await expect(service.deleteApp("tenant-attacker", "app-001")).rejects.toThrow();
    expect(appRepo.findByTenantAndId).toHaveBeenCalledWith("tenant-attacker", "app-001");
  });
});
