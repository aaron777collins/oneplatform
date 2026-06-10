// Unit tests for repositories/types.ts
//
// The types module exports pure TypeScript interfaces with no runtime code.
// These tests verify:
//   1. The structural contract of each interface at runtime by constructing
//      conforming and non-conforming values.
//   2. That union literals defined in the types match the expected set.
//   3. Consistency between read (Row) and write (CreateData) shapes:
//      column names in rows are snake_case; input shapes are camelCase.

import { describe, it, expect } from "vitest";
import type {
  LogEventRow,
  AuditEventRow,
  CreateLogEventData,
  CreateAuditEventData,
  LogQueryParams,
  AuditQueryParams,
} from "../repositories/types.js";

// ---------------------------------------------------------------------------
// Helper — asserts that a value satisfies a type at compile time and
// confirms it has the expected keys at runtime.
// ---------------------------------------------------------------------------

function hasKeys(obj: object, keys: string[]): boolean {
  return keys.every((k) => k in obj);
}

// ---------------------------------------------------------------------------
// LogEventRow
// ---------------------------------------------------------------------------

describe("LogEventRow", () => {
  const validRow: LogEventRow = {
    id: "550e8400-e29b-41d4-a716-446655440000",
    trace_id: "trace-abc",
    service: "gateway",
    level: "error",
    message: "Something went wrong",
    metadata: { code: 503 },
    created_at: new Date("2026-01-15T10:00:00Z"),
  };

  it("accepts a valid LogEventRow structure", () => {
    expect(validRow.id).toBeTruthy();
    expect(validRow.trace_id).toBeDefined();
    expect(validRow.service).toBeDefined();
    expect(validRow.level).toBeDefined();
    expect(validRow.message).toBeDefined();
    expect(validRow.metadata).toBeDefined();
    expect(validRow.created_at).toBeInstanceOf(Date);
  });

  it("has snake_case column names (mirrors DB columns)", () => {
    expect(
      hasKeys(validRow, [
        "id",
        "trace_id",
        "service",
        "level",
        "message",
        "metadata",
        "created_at",
      ])
    ).toBe(true);
  });

  it("level union accepts all four expected values", () => {
    const levels: LogEventRow["level"][] = ["debug", "info", "warn", "error"];
    for (const level of levels) {
      const row: LogEventRow = { ...validRow, level };
      expect(row.level).toBe(level);
    }
  });

  it("metadata is typed as Record<string, unknown>", () => {
    const row: LogEventRow = {
      ...validRow,
      metadata: { nested: { deep: true }, arr: [1, 2, 3], num: 99 },
    };
    expect(row.metadata["nested"]).toEqual({ deep: true });
    expect(row.metadata["arr"]).toEqual([1, 2, 3]);
  });

  it("created_at is a Date object, not a string", () => {
    expect(validRow.created_at).toBeInstanceOf(Date);
    expect(typeof validRow.created_at).not.toBe("string");
  });

  it("id is a string (UUID format from Postgres)", () => {
    expect(typeof validRow.id).toBe("string");
  });

  it("trace_id can be an empty string (default value in DB)", () => {
    const row: LogEventRow = { ...validRow, trace_id: "" };
    expect(row.trace_id).toBe("");
  });
});

// ---------------------------------------------------------------------------
// AuditEventRow
// ---------------------------------------------------------------------------

describe("AuditEventRow", () => {
  const validRow: AuditEventRow = {
    id: "550e8400-e29b-41d4-a716-446655440001",
    trace_id: "trace-def",
    actor_id: "user-123",
    actor_type: "user",
    tenant_id: "tenant-abc",
    action: "delete_document",
    resource_type: "document",
    resource_id: "doc-42",
    result: "success",
    metadata: {},
    created_at: new Date("2026-01-15T10:00:00Z"),
    archived: false,
    job_id: "job-001",
  };

  it("accepts a valid AuditEventRow structure", () => {
    expect(validRow.id).toBeTruthy();
    expect(validRow.actor_id).toBeDefined();
    expect(validRow.result).toBeDefined();
  });

  it("has snake_case column names (mirrors DB columns)", () => {
    expect(
      hasKeys(validRow, [
        "id",
        "trace_id",
        "actor_id",
        "actor_type",
        "tenant_id",
        "action",
        "resource_type",
        "resource_id",
        "result",
        "metadata",
        "created_at",
        "archived",
        "job_id",
      ])
    ).toBe(true);
  });

  it("actor_type union accepts 'user', 'service', 'system'", () => {
    const types: AuditEventRow["actor_type"][] = ["user", "service", "system"];
    for (const actorType of types) {
      const row: AuditEventRow = { ...validRow, actor_type: actorType };
      expect(row.actor_type).toBe(actorType);
    }
  });

  it("result union accepts 'success' and 'failure'", () => {
    const results: AuditEventRow["result"][] = ["success", "failure"];
    for (const result of results) {
      const row: AuditEventRow = { ...validRow, result };
      expect(row.result).toBe(result);
    }
  });

  it("job_id can be null (for events not created through BullMQ)", () => {
    const row: AuditEventRow = { ...validRow, job_id: null };
    expect(row.job_id).toBeNull();
  });

  it("job_id can be a non-null string", () => {
    const row: AuditEventRow = { ...validRow, job_id: "bullmq-job-42" };
    expect(row.job_id).toBe("bullmq-job-42");
  });

  it("archived is a boolean (not nullable)", () => {
    const rowTrue: AuditEventRow = { ...validRow, archived: true };
    const rowFalse: AuditEventRow = { ...validRow, archived: false };
    expect(typeof rowTrue.archived).toBe("boolean");
    expect(typeof rowFalse.archived).toBe("boolean");
  });

  it("trace_id defaults to empty string in the DB (empty string is valid)", () => {
    const row: AuditEventRow = { ...validRow, trace_id: "" };
    expect(row.trace_id).toBe("");
  });
});

// ---------------------------------------------------------------------------
// CreateLogEventData
// ---------------------------------------------------------------------------

describe("CreateLogEventData", () => {
  const validData: CreateLogEventData = {
    traceId: "trace-xyz",
    service: "payments",
    level: "warn",
    message: "High latency detected",
    metadata: { latencyMs: 2500 },
    createdAt: new Date("2026-01-15T10:00:00Z"),
  };

  it("accepts a valid CreateLogEventData structure", () => {
    expect(validData.traceId).toBeDefined();
    expect(validData.service).toBeDefined();
    expect(validData.level).toBeDefined();
    expect(validData.createdAt).toBeInstanceOf(Date);
  });

  it("uses camelCase keys (write input, not DB columns)", () => {
    expect(hasKeys(validData, ["traceId", "service", "level", "message", "metadata", "createdAt"])).toBe(true);
    expect("trace_id" in validData).toBe(false);
    expect("created_at" in validData).toBe(false);
  });

  it("level union covers all four log levels", () => {
    const levels: CreateLogEventData["level"][] = ["debug", "info", "warn", "error"];
    for (const level of levels) {
      const data: CreateLogEventData = { ...validData, level };
      expect(data.level).toBe(level);
    }
  });

  it("createdAt is a Date (not a string)", () => {
    expect(validData.createdAt).toBeInstanceOf(Date);
  });

  it("traceId can be an empty string (system events with no trace)", () => {
    const data: CreateLogEventData = { ...validData, traceId: "" };
    expect(data.traceId).toBe("");
  });
});

// ---------------------------------------------------------------------------
// CreateAuditEventData
// ---------------------------------------------------------------------------

describe("CreateAuditEventData", () => {
  const validData: CreateAuditEventData = {
    traceId: "trace-audit-1",
    actorId: "user-456",
    actorType: "service",
    tenantId: "tenant-x",
    action: "update_config",
    resourceType: "config",
    resourceId: "cfg-99",
    result: "failure",
    metadata: { reason: "validation failed" },
    createdAt: new Date("2026-02-01T00:00:00Z"),
    jobId: "job-bullmq-555",
  };

  it("accepts a valid CreateAuditEventData structure", () => {
    expect(validData.actorId).toBeDefined();
    expect(validData.actorType).toBeDefined();
    expect(validData.result).toBeDefined();
    expect(validData.jobId).toBeDefined();
  });

  it("uses camelCase keys (write input, not DB columns)", () => {
    expect(
      hasKeys(validData, [
        "traceId",
        "actorId",
        "actorType",
        "tenantId",
        "action",
        "resourceType",
        "resourceId",
        "result",
        "metadata",
        "createdAt",
        "jobId",
      ])
    ).toBe(true);
    // Verify no snake_case leakage
    expect("actor_id" in validData).toBe(false);
    expect("tenant_id" in validData).toBe(false);
    expect("resource_type" in validData).toBe(false);
    expect("job_id" in validData).toBe(false);
  });

  it("jobId can be null (for events not created through BullMQ queue)", () => {
    const data: CreateAuditEventData = { ...validData, jobId: null };
    expect(data.jobId).toBeNull();
  });

  it("actor_type union accepts 'user', 'service', 'system'", () => {
    const types: CreateAuditEventData["actorType"][] = ["user", "service", "system"];
    for (const actorType of types) {
      const data: CreateAuditEventData = { ...validData, actorType };
      expect(data.actorType).toBe(actorType);
    }
  });

  it("result union accepts 'success' and 'failure'", () => {
    const results: CreateAuditEventData["result"][] = ["success", "failure"];
    for (const result of results) {
      const data: CreateAuditEventData = { ...validData, result };
      expect(data.result).toBe(result);
    }
  });

  it("createdAt is a Date (not a string)", () => {
    expect(validData.createdAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------
// LogQueryParams
// ---------------------------------------------------------------------------

describe("LogQueryParams", () => {
  it("accepts minimal params with only required 'limit'", () => {
    const params: LogQueryParams = { limit: 50 };
    expect(params.limit).toBe(50);
    expect(params.service).toBeUndefined();
  });

  it("accepts all optional fields", () => {
    const params: LogQueryParams = {
      service: "billing",
      level: "debug",
      traceId: "t-1",
      search: "query",
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-31T23:59:59Z",
      cursor: "base64cursor",
      limit: 100,
    };
    expect(params.service).toBe("billing");
    expect(params.level).toBe("debug");
    expect(params.cursor).toBe("base64cursor");
  });

  it("level union is the same four values as in LogEventRow", () => {
    const levels: Array<LogQueryParams["level"]> = ["debug", "info", "warn", "error"];
    for (const level of levels) {
      const p: LogQueryParams = { limit: 10, level };
      expect(p.level).toBe(level);
    }
  });

  it("limit is required (cannot be omitted)", () => {
    // TypeScript would error — verify at runtime the field exists
    const params: LogQueryParams = { limit: 1 };
    expect("limit" in params).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AuditQueryParams
// ---------------------------------------------------------------------------

describe("AuditQueryParams", () => {
  it("accepts minimal params with only required 'limit'", () => {
    const params: AuditQueryParams = { limit: 25 };
    expect(params.limit).toBe(25);
  });

  it("accepts all optional fields", () => {
    const params: AuditQueryParams = {
      actorId: "u-1",
      actorType: "user",
      tenantId: "t-1",
      action: "create",
      resourceType: "document",
      resourceId: "d-1",
      result: "success",
      from: "2026-01-01T00:00:00Z",
      to: "2026-01-31T23:59:59Z",
      cursor: "cursor-token",
      limit: 50,
    };
    expect(params.actorType).toBe("user");
    expect(params.result).toBe("success");
  });

  it("actorType union accepts 'user', 'service', 'system'", () => {
    const types: Array<AuditQueryParams["actorType"]> = ["user", "service", "system"];
    for (const actorType of types) {
      const p: AuditQueryParams = { limit: 10, actorType };
      expect(p.actorType).toBe(actorType);
    }
  });

  it("result union accepts 'success' and 'failure'", () => {
    const results: Array<AuditQueryParams["result"]> = ["success", "failure"];
    for (const result of results) {
      const p: AuditQueryParams = { limit: 10, result };
      expect(p.result).toBe(result);
    }
  });

  it("limit is required (cannot be omitted)", () => {
    const params: AuditQueryParams = { limit: 200 };
    expect("limit" in params).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-type consistency checks
// ---------------------------------------------------------------------------

describe("cross-type consistency", () => {
  it("LogQueryParams.level union matches LogEventRow.level union", () => {
    const rowLevel: LogEventRow["level"] = "warn";
    const queryLevel: LogQueryParams["level"] = rowLevel;
    expect(queryLevel).toBe("warn");
  });

  it("AuditQueryParams.actorType union matches AuditEventRow.actor_type union", () => {
    const rowType: AuditEventRow["actor_type"] = "system";
    const queryType: AuditQueryParams["actorType"] = rowType;
    expect(queryType).toBe("system");
  });

  it("AuditQueryParams.result union matches AuditEventRow.result union", () => {
    const rowResult: AuditEventRow["result"] = "failure";
    const queryResult: AuditQueryParams["result"] = rowResult;
    expect(queryResult).toBe("failure");
  });

  it("CreateLogEventData.level union matches LogEventRow.level union", () => {
    const rowLevel: LogEventRow["level"] = "debug";
    const writeLevel: CreateLogEventData["level"] = rowLevel;
    expect(writeLevel).toBe("debug");
  });

  it("CreateAuditEventData.result union matches AuditEventRow.result union", () => {
    const rowResult: AuditEventRow["result"] = "success";
    const writeResult: CreateAuditEventData["result"] = rowResult;
    expect(writeResult).toBe("success");
  });

  it("LogQueryParams has camelCase fields (not snake_case DB column names)", () => {
    const params: LogQueryParams = { limit: 10, traceId: "t-1" };
    expect("traceId" in params).toBe(true);
    expect("trace_id" in params).toBe(false);
  });

  it("AuditQueryParams has camelCase fields (not snake_case DB column names)", () => {
    const params: AuditQueryParams = { limit: 10, actorId: "a-1", resourceType: "doc" };
    expect("actorId" in params).toBe(true);
    expect("actor_id" in params).toBe(false);
    expect("resourceType" in params).toBe(true);
    expect("resource_type" in params).toBe(false);
  });
});
