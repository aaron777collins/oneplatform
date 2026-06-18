/**
 * Tests for G-125 field-level audit trail.
 *
 * All database I/O is avoided by stubbing FieldAuditRepository with vitest mocks.
 * Route tests use the Hono app directly (no HTTP server needed).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FieldAuditRepository } from "../repositories/field-audit-repository.js";
import type {
  FieldChangeRow,
  FieldAccessRow,
  FieldChangeEntry,
  FieldAccessEntry,
} from "../repositories/types.js";
import { FieldAuditService, FieldAuditValidationError } from "../services/field-audit-service.js";
import { isSensitiveField } from "../repositories/field-audit-repository.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const NOW = "2026-06-18T12:00:00.000Z";
const TENANT = "tenant-abc";
const USER = "user-123";

function makeChangeRow(overrides: Partial<FieldChangeRow> = {}): FieldChangeRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    tenant_id: TENANT,
    user_id: USER,
    entity_type: "connector",
    entity_id: "conn-1",
    field_name: "name",
    old_value: "old",
    new_value: "new",
    action: "update",
    source: "api",
    changed_at: new Date(NOW),
    ...overrides,
  };
}

function makeAccessRow(overrides: Partial<FieldAccessRow> = {}): FieldAccessRow {
  return {
    id: "00000000-0000-0000-0000-000000000002",
    tenant_id: TENANT,
    user_id: USER,
    entity_type: "connector",
    entity_id: "conn-1",
    fields_accessed: ["name", "config"],
    purpose: "view",
    accessed_at: new Date(NOW),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Stub factory — builds a fully typed mock of FieldAuditRepository
// ---------------------------------------------------------------------------

function makeRepoStub(): FieldAuditRepository {
  return {
    insertFieldChange: vi.fn(),
    insertFieldAccess: vi.fn(),
    queryFieldHistory: vi.fn(),
    queryEntityAccess: vi.fn(),
  } as unknown as FieldAuditRepository;
}

// ---------------------------------------------------------------------------
// isSensitiveField
// ---------------------------------------------------------------------------

describe("isSensitiveField", () => {
  it("detects 'password' exactly", () => {
    expect(isSensitiveField("password")).toBe(true);
  });

  it("detects 'password' as a substring (e.g. userPassword)", () => {
    expect(isSensitiveField("userPassword")).toBe(true);
  });

  it("detects 'secret' (e.g. clientSecret)", () => {
    expect(isSensitiveField("clientSecret")).toBe(true);
  });

  it("detects 'token' (e.g. accessToken)", () => {
    expect(isSensitiveField("accessToken")).toBe(true);
  });

  it("detects 'key' as a substring (e.g. apiKey)", () => {
    expect(isSensitiveField("apiKey")).toBe(true);
  });

  it("detects 'credential' (e.g. serviceCredential)", () => {
    expect(isSensitiveField("serviceCredential")).toBe(true);
  });

  it("is case-insensitive for 'PASSWORD'", () => {
    expect(isSensitiveField("PASSWORD")).toBe(true);
  });

  it("is case-insensitive for 'TOKEN'", () => {
    expect(isSensitiveField("TOKEN")).toBe(true);
  });

  it("returns false for 'name'", () => {
    expect(isSensitiveField("name")).toBe(false);
  });

  it("returns false for 'config'", () => {
    expect(isSensitiveField("config")).toBe(false);
  });

  it("returns false for 'schedule'", () => {
    expect(isSensitiveField("schedule")).toBe(false);
  });

  it("returns false for 'description'", () => {
    expect(isSensitiveField("description")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isSensitiveField("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FieldAuditService.logFieldChange
// ---------------------------------------------------------------------------

describe("FieldAuditService.logFieldChange", () => {
  let repo: ReturnType<typeof makeRepoStub>;
  let service: FieldAuditService;

  beforeEach(() => {
    repo = makeRepoStub();
    service = new FieldAuditService(repo);
  });

  const validEntry: FieldChangeEntry = {
    tenantId: TENANT,
    userId: USER,
    entityType: "connector",
    entityId: "conn-1",
    fieldName: "name",
    oldValue: "old-name",
    newValue: "new-name",
    action: "update",
    source: "api",
    timestamp: NOW,
  };

  it("calls insertFieldChange on the repository with valid input", async () => {
    const row = makeChangeRow();
    vi.mocked(repo.insertFieldChange).mockResolvedValue(row);

    const result = await service.logFieldChange(validEntry);
    expect(repo.insertFieldChange).toHaveBeenCalledOnce();
    expect(result).toBe(row);
  });

  it("forwards the entry to the repository unchanged for non-sensitive fields", async () => {
    const row = makeChangeRow();
    vi.mocked(repo.insertFieldChange).mockResolvedValue(row);

    await service.logFieldChange(validEntry);
    const arg = vi.mocked(repo.insertFieldChange).mock.calls[0]![0];
    expect(arg?.fieldName).toBe("name");
  });

  it("accepts action='create' with undefined oldValue", async () => {
    const row = makeChangeRow({ action: "create", old_value: undefined });
    vi.mocked(repo.insertFieldChange).mockResolvedValue(row);

    await service.logFieldChange({ ...validEntry, action: "create", oldValue: undefined });
    expect(repo.insertFieldChange).toHaveBeenCalledOnce();
  });

  it("accepts action='delete' with undefined newValue", async () => {
    const row = makeChangeRow({ action: "delete", new_value: undefined });
    vi.mocked(repo.insertFieldChange).mockResolvedValue(row);

    await service.logFieldChange({ ...validEntry, action: "delete", newValue: undefined });
    expect(repo.insertFieldChange).toHaveBeenCalledOnce();
  });

  it("accepts all three source values", async () => {
    const sources: FieldChangeEntry["source"][] = ["api", "ui", "system"];
    for (const source of sources) {
      repo.insertFieldChange = vi.fn().mockResolvedValue(makeChangeRow());
      await service.logFieldChange({ ...validEntry, source });
      expect(repo.insertFieldChange).toHaveBeenCalledOnce();
    }
  });

  it("throws FieldAuditValidationError when tenantId is empty", async () => {
    await expect(
      service.logFieldChange({ ...validEntry, tenantId: "" })
    ).rejects.toBeInstanceOf(FieldAuditValidationError);
    expect(repo.insertFieldChange).not.toHaveBeenCalled();
  });

  it("throws FieldAuditValidationError when userId is empty", async () => {
    await expect(
      service.logFieldChange({ ...validEntry, userId: "" })
    ).rejects.toBeInstanceOf(FieldAuditValidationError);
    expect(repo.insertFieldChange).not.toHaveBeenCalled();
  });

  it("throws FieldAuditValidationError when entityType is empty", async () => {
    await expect(
      service.logFieldChange({ ...validEntry, entityType: "" })
    ).rejects.toBeInstanceOf(FieldAuditValidationError);
    expect(repo.insertFieldChange).not.toHaveBeenCalled();
  });

  it("throws FieldAuditValidationError for invalid action", async () => {
    await expect(
      // @ts-expect-error — intentionally testing runtime validation
      service.logFieldChange({ ...validEntry, action: "modify" })
    ).rejects.toBeInstanceOf(FieldAuditValidationError);
  });

  it("throws FieldAuditValidationError for invalid source", async () => {
    await expect(
      // @ts-expect-error
      service.logFieldChange({ ...validEntry, source: "cli" })
    ).rejects.toBeInstanceOf(FieldAuditValidationError);
  });

  it("throws FieldAuditValidationError for non-ISO timestamp", async () => {
    await expect(
      service.logFieldChange({ ...validEntry, timestamp: "not-a-date" })
    ).rejects.toBeInstanceOf(FieldAuditValidationError);
  });
});

// ---------------------------------------------------------------------------
// FieldAuditService.logFieldAccess
// ---------------------------------------------------------------------------

describe("FieldAuditService.logFieldAccess", () => {
  let repo: ReturnType<typeof makeRepoStub>;
  let service: FieldAuditService;

  beforeEach(() => {
    repo = makeRepoStub();
    service = new FieldAuditService(repo);
  });

  const validEntry: FieldAccessEntry = {
    tenantId: TENANT,
    userId: USER,
    entityType: "pipeline",
    entityId: "pipe-99",
    fieldsAccessed: ["name", "schedule"],
    timestamp: NOW,
    purpose: "view",
  };

  it("calls insertFieldAccess on the repository with valid input", async () => {
    const row = makeAccessRow();
    vi.mocked(repo.insertFieldAccess).mockResolvedValue(row);

    const result = await service.logFieldAccess(validEntry);
    expect(repo.insertFieldAccess).toHaveBeenCalledOnce();
    expect(result).toBe(row);
  });

  it("accepts all three purpose values", async () => {
    const purposes: FieldAccessEntry["purpose"][] = ["view", "export", "api"];
    for (const purpose of purposes) {
      repo.insertFieldAccess = vi.fn().mockResolvedValue(makeAccessRow());
      await service.logFieldAccess({ ...validEntry, purpose });
      expect(repo.insertFieldAccess).toHaveBeenCalledOnce();
    }
  });

  it("throws FieldAuditValidationError for empty fieldsAccessed array", async () => {
    await expect(
      service.logFieldAccess({ ...validEntry, fieldsAccessed: [] })
    ).rejects.toBeInstanceOf(FieldAuditValidationError);
    expect(repo.insertFieldAccess).not.toHaveBeenCalled();
  });

  it("throws FieldAuditValidationError for invalid purpose", async () => {
    await expect(
      // @ts-expect-error
      service.logFieldAccess({ ...validEntry, purpose: "read" })
    ).rejects.toBeInstanceOf(FieldAuditValidationError);
  });

  it("throws FieldAuditValidationError when tenantId is missing", async () => {
    await expect(
      // @ts-expect-error
      service.logFieldAccess({ ...validEntry, tenantId: undefined })
    ).rejects.toBeInstanceOf(FieldAuditValidationError);
  });
});

// ---------------------------------------------------------------------------
// FieldAuditService.getFieldHistory
// ---------------------------------------------------------------------------

describe("FieldAuditService.getFieldHistory", () => {
  let repo: ReturnType<typeof makeRepoStub>;
  let service: FieldAuditService;

  beforeEach(() => {
    repo = makeRepoStub();
    service = new FieldAuditService(repo);
  });

  it("delegates to queryFieldHistory with validated params", async () => {
    const rows = [makeChangeRow()];
    vi.mocked(repo.queryFieldHistory).mockResolvedValue({ data: rows, nextCursor: null });

    const result = await service.getFieldHistory(TENANT, "connector", "conn-1", {
      limit: 50,
    });

    expect(repo.queryFieldHistory).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ entityType: "connector", entityId: "conn-1", limit: 50 })
    );
    expect(result.data).toBe(rows);
    expect(result.nextCursor).toBeNull();
  });

  it("passes fieldName filter through to the repository", async () => {
    vi.mocked(repo.queryFieldHistory).mockResolvedValue({ data: [], nextCursor: null });

    await service.getFieldHistory(TENANT, "app", "app-5", {
      fieldName: "schedule",
      limit: 100,
    });

    expect(repo.queryFieldHistory).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ fieldName: "schedule" })
    );
  });

  it("passes userId filter through to the repository", async () => {
    vi.mocked(repo.queryFieldHistory).mockResolvedValue({ data: [], nextCursor: null });

    await service.getFieldHistory(TENANT, "connector", "conn-1", {
      userId: "user-999",
      limit: 100,
    });

    expect(repo.queryFieldHistory).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ userId: "user-999" })
    );
  });

  it("passes time range filters through to the repository", async () => {
    vi.mocked(repo.queryFieldHistory).mockResolvedValue({ data: [], nextCursor: null });

    const from = "2026-01-01T00:00:00.000Z";
    const to = "2026-06-01T00:00:00.000Z";

    await service.getFieldHistory(TENANT, "connector", "conn-1", { from, to, limit: 100 });

    expect(repo.queryFieldHistory).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ from, to })
    );
  });

  it("forwards cursor pagination parameters", async () => {
    vi.mocked(repo.queryFieldHistory).mockResolvedValue({ data: [], nextCursor: null });

    // cursor is a base64url string — service passes it through; repo validates it
    const cursor = "eyJ0cyI6IjIwMjYtMDEtMDFUMDA6MDA6MDAuMDAwWiIsImlkIjoiMDAwMDAwMDAtMDAwMC0wMDAwLTAwMDAtMDAwMDAwMDAwMDAxIn0.abc";
    await service.getFieldHistory(TENANT, "connector", "conn-1", { cursor, limit: 10 });

    expect(repo.queryFieldHistory).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ cursor })
    );
  });

  it("applies default limit of 100 when omitted", async () => {
    vi.mocked(repo.queryFieldHistory).mockResolvedValue({ data: [], nextCursor: null });

    await service.getFieldHistory(TENANT, "connector", "conn-1", {});

    expect(repo.queryFieldHistory).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ limit: 100 })
    );
  });

  it("throws FieldAuditValidationError for empty tenantId", async () => {
    await expect(
      service.getFieldHistory("", "connector", "conn-1", { limit: 10 })
    ).rejects.toBeInstanceOf(FieldAuditValidationError);
    expect(repo.queryFieldHistory).not.toHaveBeenCalled();
  });

  it("throws FieldAuditValidationError for limit above 500", async () => {
    await expect(
      service.getFieldHistory(TENANT, "connector", "conn-1", { limit: 501 })
    ).rejects.toBeInstanceOf(FieldAuditValidationError);
  });

  it("throws FieldAuditValidationError for limit of 0", async () => {
    await expect(
      service.getFieldHistory(TENANT, "connector", "conn-1", { limit: 0 })
    ).rejects.toBeInstanceOf(FieldAuditValidationError);
  });

  it("throws FieldAuditValidationError for malformed from datetime", async () => {
    await expect(
      service.getFieldHistory(TENANT, "connector", "conn-1", {
        from: "not-a-date",
        limit: 10,
      })
    ).rejects.toBeInstanceOf(FieldAuditValidationError);
  });
});

// ---------------------------------------------------------------------------
// FieldAuditService.getEntityAuditLog
// ---------------------------------------------------------------------------

describe("FieldAuditService.getEntityAuditLog", () => {
  let repo: ReturnType<typeof makeRepoStub>;
  let service: FieldAuditService;

  beforeEach(() => {
    repo = makeRepoStub();
    service = new FieldAuditService(repo);
  });

  it("calls queryFieldHistory without fieldName filter", async () => {
    vi.mocked(repo.queryFieldHistory).mockResolvedValue({ data: [], nextCursor: null });

    await service.getEntityAuditLog(TENANT, "connector", "conn-1", { limit: 50 });

    const params = vi.mocked(repo.queryFieldHistory).mock.calls[0]![1];
    expect(params?.fieldName).toBeUndefined();
  });

  it("returns paginated results from the repository", async () => {
    const rows = [makeChangeRow(), makeChangeRow({ id: "00000000-0000-0000-0000-000000000099" })];
    vi.mocked(repo.queryFieldHistory).mockResolvedValue({ data: rows, nextCursor: "cursor-token" });

    const result = await service.getEntityAuditLog(TENANT, "connector", "conn-1", { limit: 2 });

    expect(result.data).toHaveLength(2);
    expect(result.nextCursor).toBe("cursor-token");
  });
});

// ---------------------------------------------------------------------------
// FieldAuditService.getEntityAccessLog
// ---------------------------------------------------------------------------

describe("FieldAuditService.getEntityAccessLog", () => {
  let repo: ReturnType<typeof makeRepoStub>;
  let service: FieldAuditService;

  beforeEach(() => {
    repo = makeRepoStub();
    service = new FieldAuditService(repo);
  });

  it("calls queryEntityAccess with correct entity coordinates", async () => {
    vi.mocked(repo.queryEntityAccess).mockResolvedValue({ data: [], nextCursor: null });

    await service.getEntityAccessLog(TENANT, "app", "app-42", { limit: 25 });

    expect(repo.queryEntityAccess).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ entityType: "app", entityId: "app-42" })
    );
  });

  it("forwards userId filter to the repository", async () => {
    vi.mocked(repo.queryEntityAccess).mockResolvedValue({ data: [], nextCursor: null });

    await service.getEntityAccessLog(TENANT, "app", "app-42", {
      userId: "u-777",
      limit: 10,
    });

    expect(repo.queryEntityAccess).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ userId: "u-777" })
    );
  });

  it("returns access rows from the repository", async () => {
    const rows = [makeAccessRow()];
    vi.mocked(repo.queryEntityAccess).mockResolvedValue({ data: rows, nextCursor: null });

    const result = await service.getEntityAccessLog(TENANT, "app", "app-1", { limit: 10 });

    expect(result.data).toBe(rows);
  });

  it("throws FieldAuditValidationError for empty entityType", async () => {
    await expect(
      service.getEntityAccessLog(TENANT, "", "app-1", { limit: 10 })
    ).rejects.toBeInstanceOf(FieldAuditValidationError);
    expect(repo.queryEntityAccess).not.toHaveBeenCalled();
  });

  it("throws FieldAuditValidationError for limit above 500", async () => {
    await expect(
      service.getEntityAccessLog(TENANT, "app", "app-1", { limit: 999 })
    ).rejects.toBeInstanceOf(FieldAuditValidationError);
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation — service enforces tenantId from the call site
// ---------------------------------------------------------------------------

describe("tenant isolation", () => {
  it("queryFieldHistory is always called with the tenantId passed by the caller", async () => {
    const repo = makeRepoStub();
    const service = new FieldAuditService(repo);
    vi.mocked(repo.queryFieldHistory).mockResolvedValue({ data: [], nextCursor: null });

    await service.getFieldHistory("tenant-A", "connector", "conn-1", { limit: 10 });
    expect(repo.queryFieldHistory).toHaveBeenCalledWith("tenant-A", expect.any(Object));

    await service.getFieldHistory("tenant-B", "connector", "conn-1", { limit: 10 });
    expect(repo.queryFieldHistory).toHaveBeenLastCalledWith("tenant-B", expect.any(Object));
  });

  it("queryEntityAccess is always called with the tenantId passed by the caller", async () => {
    const repo = makeRepoStub();
    const service = new FieldAuditService(repo);
    vi.mocked(repo.queryEntityAccess).mockResolvedValue({ data: [], nextCursor: null });

    await service.getEntityAccessLog("tenant-X", "app", "a-1", { limit: 10 });
    expect(repo.queryEntityAccess).toHaveBeenCalledWith("tenant-X", expect.any(Object));
  });
});

// ---------------------------------------------------------------------------
// FieldAuditValidationError
// ---------------------------------------------------------------------------

describe("FieldAuditValidationError", () => {
  it("has statusCode 400", () => {
    const err = new FieldAuditValidationError("bad input", []);
    expect(err.statusCode).toBe(400);
  });

  it("has code FIELD_AUDIT_VALIDATION_ERROR", () => {
    const err = new FieldAuditValidationError("bad input", []);
    expect(err.code).toBe("FIELD_AUDIT_VALIDATION_ERROR");
  });

  it("preserves the message", () => {
    const err = new FieldAuditValidationError("must have tenantId", []);
    expect(err.message).toBe("must have tenantId");
  });

  it("stores issues array", () => {
    const issues = [{ code: "too_small" as const, message: "Required", path: ["tenantId"], minimum: 1, type: "string" as const, inclusive: true }];
    const err = new FieldAuditValidationError("err", issues);
    expect(err.issues).toHaveLength(1);
  });

  it("is an instance of Error", () => {
    const err = new FieldAuditValidationError("err", []);
    expect(err).toBeInstanceOf(Error);
  });
});
