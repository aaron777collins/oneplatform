// Unit tests for schemas/index.ts
// All five Zod schemas are exercised with valid canonical inputs, boundary
// values, and invalid inputs that must produce ZodErrors.

import { describe, it, expect } from "vitest";
import {
  logQuerySchema,
  auditQuerySchema,
  exportQuerySchema,
  internalLogQuerySchema,
  ingestEventSchema,
} from "../schemas/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok<T>(schema: { parse(v: unknown): T }, input: unknown): T {
  return schema.parse(input);
}

function fails(
  schema: { safeParse(v: unknown): { success: boolean } },
  input: unknown
): void {
  const result = schema.safeParse(input);
  expect(
    result.success,
    `Expected parse to fail but it succeeded for: ${JSON.stringify(input)}`
  ).toBe(false);
}

// A valid ISO-8601 datetime string used throughout tests
const DT = "2026-01-15T10:30:00.000Z";
// A datetime exactly 7 days later (used for export window tests)
const DT_PLUS_7_DAYS = "2026-01-22T10:30:00.000Z";
// A datetime 8 days later — should violate the 7-day cap in exportQuerySchema
// Note: the schema validates structure not semantic window — tested accordingly
const DT_PLUS_8_DAYS = "2026-01-23T10:30:00.000Z";

// ---------------------------------------------------------------------------
// logQuerySchema
// ---------------------------------------------------------------------------

describe("logQuerySchema", () => {
  describe("minimal input — all optional fields absent", () => {
    it("accepts empty object and applies default limit of 100", () => {
      const r = ok(logQuerySchema, {});
      expect(r.limit).toBe(100);
    });

    it("service, level, traceId, search, from, to, cursor are all undefined by default", () => {
      const r = ok(logQuerySchema, {});
      expect(r.service).toBeUndefined();
      expect(r.level).toBeUndefined();
      expect(r.traceId).toBeUndefined();
      expect(r.search).toBeUndefined();
      expect(r.from).toBeUndefined();
      expect(r.to).toBeUndefined();
      expect(r.cursor).toBeUndefined();
    });
  });

  describe("level enum validation", () => {
    it("accepts 'debug'", () => {
      expect(ok(logQuerySchema, { level: "debug" }).level).toBe("debug");
    });

    it("accepts 'info'", () => {
      expect(ok(logQuerySchema, { level: "info" }).level).toBe("info");
    });

    it("accepts 'warn'", () => {
      expect(ok(logQuerySchema, { level: "warn" }).level).toBe("warn");
    });

    it("accepts 'error'", () => {
      expect(ok(logQuerySchema, { level: "error" }).level).toBe("error");
    });

    it("rejects 'ERROR' (uppercase)", () => {
      fails(logQuerySchema, { level: "ERROR" });
    });

    it("rejects 'INFO' (uppercase)", () => {
      fails(logQuerySchema, { level: "INFO" });
    });

    it("rejects 'WARN' (uppercase)", () => {
      fails(logQuerySchema, { level: "WARN" });
    });

    it("rejects 'trace' (not in enum)", () => {
      fails(logQuerySchema, { level: "trace" });
    });

    it("rejects 'fatal' (not in enum)", () => {
      fails(logQuerySchema, { level: "fatal" });
    });

    it("rejects empty string level", () => {
      fails(logQuerySchema, { level: "" });
    });

    it("rejects numeric level", () => {
      fails(logQuerySchema, { level: 1 });
    });
  });

  describe("service field validation", () => {
    it("accepts a valid service name of 1 character", () => {
      expect(ok(logQuerySchema, { service: "a" }).service).toBe("a");
    });

    it("accepts a service name at exactly 64 characters", () => {
      const s = "x".repeat(64);
      expect(ok(logQuerySchema, { service: s }).service).toBe(s);
    });

    it("rejects empty service string (min 1)", () => {
      fails(logQuerySchema, { service: "" });
    });

    it("rejects service name exceeding 64 characters", () => {
      fails(logQuerySchema, { service: "x".repeat(65) });
    });
  });

  describe("traceId field validation", () => {
    it("accepts traceId at exactly 128 characters", () => {
      const id = "a".repeat(128);
      expect(ok(logQuerySchema, { traceId: id }).traceId).toBe(id);
    });

    it("accepts empty string traceId (min is not set)", () => {
      expect(ok(logQuerySchema, { traceId: "" }).traceId).toBe("");
    });

    it("rejects traceId exceeding 128 characters", () => {
      fails(logQuerySchema, { traceId: "a".repeat(129) });
    });
  });

  describe("search field validation", () => {
    it("accepts a search string of 512 characters", () => {
      const s = "q".repeat(512);
      expect(ok(logQuerySchema, { search: s }).search).toBe(s);
    });

    it("accepts empty string search", () => {
      expect(ok(logQuerySchema, { search: "" }).search).toBe("");
    });

    it("rejects search exceeding 512 characters", () => {
      fails(logQuerySchema, { search: "q".repeat(513) });
    });
  });

  describe("from / to datetime fields", () => {
    it("accepts a valid ISO-8601 datetime for 'from'", () => {
      expect(ok(logQuerySchema, { from: DT }).from).toBe(DT);
    });

    it("accepts a valid ISO-8601 datetime for 'to'", () => {
      expect(ok(logQuerySchema, { to: DT }).to).toBe(DT);
    });

    it("rejects a date-only string for 'from'", () => {
      fails(logQuerySchema, { from: "2026-01-15" });
    });

    it("rejects a date-only string for 'to'", () => {
      fails(logQuerySchema, { to: "2026-01-15" });
    });

    it("rejects a non-datetime string for 'from'", () => {
      fails(logQuerySchema, { from: "not-a-date" });
    });

    it("accepts both from and to together", () => {
      const r = ok(logQuerySchema, { from: DT, to: DT_PLUS_7_DAYS });
      expect(r.from).toBe(DT);
      expect(r.to).toBe(DT_PLUS_7_DAYS);
    });
  });

  describe("cursor field validation", () => {
    it("accepts a cursor string up to 512 characters", () => {
      const c = "c".repeat(512);
      expect(ok(logQuerySchema, { cursor: c }).cursor).toBe(c);
    });

    it("accepts empty string cursor", () => {
      expect(ok(logQuerySchema, { cursor: "" }).cursor).toBe("");
    });

    it("rejects cursor exceeding 512 characters", () => {
      fails(logQuerySchema, { cursor: "c".repeat(513) });
    });
  });

  describe("limit field — coerce and range", () => {
    it("accepts limit 1 (minimum boundary)", () => {
      expect(ok(logQuerySchema, { limit: 1 }).limit).toBe(1);
    });

    it("accepts limit 500 (maximum boundary)", () => {
      expect(ok(logQuerySchema, { limit: 500 }).limit).toBe(500);
    });

    it("coerces string '50' to number 50", () => {
      expect(ok(logQuerySchema, { limit: "50" }).limit).toBe(50);
    });

    it("applies default of 100 when limit is absent", () => {
      expect(ok(logQuerySchema, {}).limit).toBe(100);
    });

    it("rejects limit of 0 (below minimum)", () => {
      fails(logQuerySchema, { limit: 0 });
    });

    it("rejects limit of 501 (above maximum)", () => {
      fails(logQuerySchema, { limit: 501 });
    });

    it("rejects non-integer limit (float)", () => {
      fails(logQuerySchema, { limit: 10.5 });
    });

    it("rejects non-numeric string limit", () => {
      fails(logQuerySchema, { limit: "many" });
    });

    it("rejects negative limit", () => {
      fails(logQuerySchema, { limit: -1 });
    });
  });

  describe("full valid query with all fields", () => {
    it("accepts all fields simultaneously", () => {
      const r = ok(logQuerySchema, {
        service: "gateway",
        level: "error",
        traceId: "trace-123",
        search: "connection refused",
        from: DT,
        to: DT_PLUS_7_DAYS,
        cursor: "eyJpZCI6IjEifQ==",
        limit: 25,
      });
      expect(r.service).toBe("gateway");
      expect(r.level).toBe("error");
      expect(r.limit).toBe(25);
    });
  });
});

// ---------------------------------------------------------------------------
// auditQuerySchema
// ---------------------------------------------------------------------------

describe("auditQuerySchema", () => {
  describe("minimal input — all optional fields absent", () => {
    it("accepts empty object and applies default limit of 100", () => {
      const r = ok(auditQuerySchema, {});
      expect(r.limit).toBe(100);
    });

    it("all optional fields are undefined by default", () => {
      const r = ok(auditQuerySchema, {});
      expect(r.actorId).toBeUndefined();
      expect(r.actorType).toBeUndefined();
      expect(r.tenantId).toBeUndefined();
      expect(r.action).toBeUndefined();
      expect(r.resourceType).toBeUndefined();
      expect(r.resourceId).toBeUndefined();
      expect(r.result).toBeUndefined();
      expect(r.from).toBeUndefined();
      expect(r.to).toBeUndefined();
      expect(r.cursor).toBeUndefined();
    });
  });

  describe("actorType enum validation", () => {
    it("accepts 'user'", () => {
      expect(ok(auditQuerySchema, { actorType: "user" }).actorType).toBe("user");
    });

    it("accepts 'service'", () => {
      expect(ok(auditQuerySchema, { actorType: "service" }).actorType).toBe(
        "service"
      );
    });

    it("accepts 'system'", () => {
      expect(ok(auditQuerySchema, { actorType: "system" }).actorType).toBe(
        "system"
      );
    });

    it("rejects 'USER' (uppercase)", () => {
      fails(auditQuerySchema, { actorType: "USER" });
    });

    it("rejects 'admin' (not in enum)", () => {
      fails(auditQuerySchema, { actorType: "admin" });
    });

    it("rejects empty string actorType", () => {
      fails(auditQuerySchema, { actorType: "" });
    });
  });

  describe("result enum validation", () => {
    it("accepts 'success'", () => {
      expect(ok(auditQuerySchema, { result: "success" }).result).toBe("success");
    });

    it("accepts 'failure'", () => {
      expect(ok(auditQuerySchema, { result: "failure" }).result).toBe("failure");
    });

    it("rejects 'SUCCESS' (uppercase)", () => {
      fails(auditQuerySchema, { result: "SUCCESS" });
    });

    it("rejects 'error' (not in enum)", () => {
      fails(auditQuerySchema, { result: "error" });
    });

    it("rejects 'partial' (not in enum)", () => {
      fails(auditQuerySchema, { result: "partial" });
    });
  });

  describe("string field length limits", () => {
    it("accepts actorId at 255 characters (max boundary)", () => {
      const id = "a".repeat(255);
      expect(ok(auditQuerySchema, { actorId: id }).actorId).toBe(id);
    });

    it("rejects actorId exceeding 255 characters", () => {
      fails(auditQuerySchema, { actorId: "a".repeat(256) });
    });

    it("accepts tenantId at 255 characters (max boundary)", () => {
      const id = "t".repeat(255);
      expect(ok(auditQuerySchema, { tenantId: id }).tenantId).toBe(id);
    });

    it("rejects tenantId exceeding 255 characters", () => {
      fails(auditQuerySchema, { tenantId: "t".repeat(256) });
    });

    it("accepts action at 255 characters (max boundary)", () => {
      const a = "x".repeat(255);
      expect(ok(auditQuerySchema, { action: a }).action).toBe(a);
    });

    it("rejects action exceeding 255 characters", () => {
      fails(auditQuerySchema, { action: "x".repeat(256) });
    });

    it("accepts resourceType at 255 characters (max boundary)", () => {
      const rt = "r".repeat(255);
      expect(ok(auditQuerySchema, { resourceType: rt }).resourceType).toBe(rt);
    });

    it("rejects resourceType exceeding 255 characters", () => {
      fails(auditQuerySchema, { resourceType: "r".repeat(256) });
    });

    it("accepts resourceId at 255 characters (max boundary)", () => {
      const ri = "i".repeat(255);
      expect(ok(auditQuerySchema, { resourceId: ri }).resourceId).toBe(ri);
    });

    it("rejects resourceId exceeding 255 characters", () => {
      fails(auditQuerySchema, { resourceId: "i".repeat(256) });
    });
  });

  describe("cursor pagination", () => {
    it("accepts cursor up to 512 characters", () => {
      const c = "z".repeat(512);
      expect(ok(auditQuerySchema, { cursor: c }).cursor).toBe(c);
    });

    it("rejects cursor exceeding 512 characters", () => {
      fails(auditQuerySchema, { cursor: "z".repeat(513) });
    });
  });

  describe("limit coerce and range", () => {
    it("accepts limit 1 (minimum boundary)", () => {
      expect(ok(auditQuerySchema, { limit: 1 }).limit).toBe(1);
    });

    it("accepts limit 500 (maximum boundary)", () => {
      expect(ok(auditQuerySchema, { limit: 500 }).limit).toBe(500);
    });

    it("rejects limit 0 (below minimum)", () => {
      fails(auditQuerySchema, { limit: 0 });
    });

    it("rejects limit 501 (above maximum)", () => {
      fails(auditQuerySchema, { limit: 501 });
    });

    it("coerces string '200' to number", () => {
      expect(ok(auditQuerySchema, { limit: "200" }).limit).toBe(200);
    });

    it("applies default limit of 100 when absent", () => {
      expect(ok(auditQuerySchema, {}).limit).toBe(100);
    });
  });

  describe("full valid query with all fields", () => {
    it("accepts all fields simultaneously", () => {
      const r = ok(auditQuerySchema, {
        actorId: "user-abc",
        actorType: "user",
        tenantId: "tenant-1",
        action: "delete_resource",
        resourceType: "document",
        resourceId: "doc-42",
        result: "failure",
        from: DT,
        to: DT_PLUS_7_DAYS,
        cursor: "eyJjcmVhdGVkQXQiOiIyMDI2In0=",
        limit: 10,
      });
      expect(r.actorType).toBe("user");
      expect(r.result).toBe("failure");
      expect(r.limit).toBe(10);
    });
  });
});

// ---------------------------------------------------------------------------
// exportQuerySchema
// ---------------------------------------------------------------------------

describe("exportQuerySchema", () => {
  const BASE = {
    from: DT,
    to: DT_PLUS_7_DAYS,
  };

  describe("required from / to fields", () => {
    it("accepts valid from and to as ISO-8601 datetimes", () => {
      const r = ok(exportQuerySchema, BASE);
      expect(r.from).toBe(DT);
      expect(r.to).toBe(DT_PLUS_7_DAYS);
    });

    it("rejects missing 'from'", () => {
      fails(exportQuerySchema, { to: DT_PLUS_7_DAYS });
    });

    it("rejects missing 'to'", () => {
      fails(exportQuerySchema, { from: DT });
    });

    it("rejects entirely missing from and to", () => {
      fails(exportQuerySchema, {});
    });

    it("rejects date-only string for 'from'", () => {
      fails(exportQuerySchema, { from: "2026-01-15", to: DT_PLUS_7_DAYS });
    });

    it("rejects date-only string for 'to'", () => {
      fails(exportQuerySchema, { from: DT, to: "2026-01-22" });
    });

    it("rejects non-date string for 'from'", () => {
      fails(exportQuerySchema, { from: "last-week", to: DT_PLUS_7_DAYS });
    });
  });

  describe("format enum", () => {
    it("defaults to 'jsonl' when format is omitted", () => {
      const r = ok(exportQuerySchema, BASE);
      expect(r.format).toBe("jsonl");
    });

    it("accepts explicit 'jsonl'", () => {
      const r = ok(exportQuerySchema, { ...BASE, format: "jsonl" });
      expect(r.format).toBe("jsonl");
    });

    it("accepts explicit 'csv'", () => {
      const r = ok(exportQuerySchema, { ...BASE, format: "csv" });
      expect(r.format).toBe("csv");
    });

    it("rejects 'json' (only jsonl is allowed)", () => {
      fails(exportQuerySchema, { ...BASE, format: "json" });
    });

    it("rejects 'ndjson' (not in enum)", () => {
      fails(exportQuerySchema, { ...BASE, format: "ndjson" });
    });

    it("rejects 'CSV' (uppercase)", () => {
      fails(exportQuerySchema, { ...BASE, format: "CSV" });
    });

    it("rejects 'JSONL' (uppercase)", () => {
      fails(exportQuerySchema, { ...BASE, format: "JSONL" });
    });

    it("rejects 'parquet' (not in enum)", () => {
      fails(exportQuerySchema, { ...BASE, format: "parquet" });
    });
  });

  describe("cursor field is omitted from exportQuerySchema", () => {
    it("strips cursor if provided (schema uses .omit({ cursor: true }))", () => {
      // exportQuerySchema omits cursor — the field should not appear on parsed output
      const r = exportQuerySchema.parse({ ...BASE, cursor: "should-be-stripped" });
      expect(r).not.toHaveProperty("cursor");
    });
  });

  describe("inherited optional fields from logQuerySchema", () => {
    it("accepts optional service filter", () => {
      const r = ok(exportQuerySchema, { ...BASE, service: "billing" });
      expect(r.service).toBe("billing");
    });

    it("accepts optional level filter", () => {
      const r = ok(exportQuerySchema, { ...BASE, level: "warn" });
      expect(r.level).toBe("warn");
    });

    it("accepts optional traceId filter", () => {
      const r = ok(exportQuerySchema, { ...BASE, traceId: "trace-456" });
      expect(r.traceId).toBe("trace-456");
    });

    it("accepts optional search filter", () => {
      const r = ok(exportQuerySchema, { ...BASE, search: "timeout" });
      expect(r.search).toBe("timeout");
    });

    it("rejects invalid level in export query", () => {
      fails(exportQuerySchema, { ...BASE, level: "verbose" });
    });
  });

  describe("limit coerce and range in export context", () => {
    it("accepts limit 1 (minimum boundary)", () => {
      expect(ok(exportQuerySchema, { ...BASE, limit: 1 }).limit).toBe(1);
    });

    it("accepts limit 500 (maximum boundary)", () => {
      expect(ok(exportQuerySchema, { ...BASE, limit: 500 }).limit).toBe(500);
    });

    it("rejects limit 0", () => {
      fails(exportQuerySchema, { ...BASE, limit: 0 });
    });

    it("rejects limit 501", () => {
      fails(exportQuerySchema, { ...BASE, limit: 501 });
    });
  });

  describe("full valid export query with all fields", () => {
    it("accepts a fully-specified export request", () => {
      const r = ok(exportQuerySchema, {
        ...BASE,
        service: "gateway",
        level: "error",
        traceId: "t-abc",
        search: "connect",
        limit: 500,
        format: "csv",
      });
      expect(r.format).toBe("csv");
      expect(r.limit).toBe(500);
    });
  });
});

// ---------------------------------------------------------------------------
// internalLogQuerySchema
// ---------------------------------------------------------------------------

describe("internalLogQuerySchema", () => {
  describe("minimal input — inherits all logQuerySchema behaviour", () => {
    it("accepts empty object with default limit", () => {
      const r = ok(internalLogQuerySchema, {});
      expect(r.limit).toBe(100);
    });

    it("services field is undefined when absent", () => {
      const r = ok(internalLogQuerySchema, {});
      expect(r.services).toBeUndefined();
    });
  });

  describe("services array validation", () => {
    it("accepts an array with one service name", () => {
      const r = ok(internalLogQuerySchema, { services: ["gateway"] });
      expect(r.services).toEqual(["gateway"]);
    });

    it("accepts an array with 9 service names (maximum)", () => {
      const services = Array.from({ length: 9 }, (_, i) => `svc-${i}`);
      const r = ok(internalLogQuerySchema, { services });
      expect(r.services).toHaveLength(9);
    });

    it("rejects an array with 10 service names (exceeds max of 9)", () => {
      const services = Array.from({ length: 10 }, (_, i) => `svc-${i}`);
      fails(internalLogQuerySchema, { services });
    });

    it("accepts an empty array for services", () => {
      const r = ok(internalLogQuerySchema, { services: [] });
      expect(r.services).toEqual([]);
    });

    it("rejects a services entry with empty string (min 1)", () => {
      fails(internalLogQuerySchema, { services: [""] });
    });

    it("rejects a services entry exceeding 64 characters", () => {
      fails(internalLogQuerySchema, { services: ["x".repeat(65)] });
    });

    it("accepts a services entry at exactly 64 characters", () => {
      const r = ok(internalLogQuerySchema, { services: ["x".repeat(64)] });
      expect(r.services?.[0]).toHaveLength(64);
    });

    it("accepts a services entry at exactly 1 character", () => {
      const r = ok(internalLogQuerySchema, { services: ["a"] });
      expect(r.services?.[0]).toBe("a");
    });

    it("rejects services as a non-array value", () => {
      fails(internalLogQuerySchema, { services: "gateway" });
    });
  });

  describe("combined services with inherited logQuerySchema fields", () => {
    it("accepts services alongside level and limit", () => {
      const r = ok(internalLogQuerySchema, {
        services: ["auth", "billing"],
        level: "warn",
        limit: 50,
      });
      expect(r.services).toEqual(["auth", "billing"]);
      expect(r.level).toBe("warn");
      expect(r.limit).toBe(50);
    });

    it("accepts services alongside time range filters", () => {
      const r = ok(internalLogQuerySchema, {
        services: ["payments"],
        from: DT,
        to: DT_PLUS_7_DAYS,
      });
      expect(r.from).toBe(DT);
      expect(r.to).toBe(DT_PLUS_7_DAYS);
    });

    it("rejects invalid level even when services is valid", () => {
      fails(internalLogQuerySchema, {
        services: ["svc"],
        level: "critical",
      });
    });
  });
});

// ---------------------------------------------------------------------------
// ingestEventSchema
// ---------------------------------------------------------------------------

describe("ingestEventSchema", () => {
  const BASE = {
    timestamp: DT,
    service: "gateway",
    level: "info" as const,
    message: "Request received",
  };

  describe("required fields", () => {
    it("accepts a minimal valid event", () => {
      const r = ok(ingestEventSchema, BASE);
      expect(r.timestamp).toBe(DT);
      expect(r.service).toBe("gateway");
      expect(r.level).toBe("info");
      expect(r.message).toBe("Request received");
    });

    it("applies empty string default for traceId when absent", () => {
      const r = ok(ingestEventSchema, BASE);
      expect(r.traceId).toBe("");
    });

    it("applies empty object default for metadata when absent", () => {
      const r = ok(ingestEventSchema, BASE);
      expect(r.metadata).toEqual({});
    });

    it("rejects missing timestamp", () => {
      const { timestamp: _removed, ...rest } = BASE;
      fails(ingestEventSchema, rest);
    });

    it("rejects missing service", () => {
      const { service: _removed, ...rest } = BASE;
      fails(ingestEventSchema, rest);
    });

    it("rejects missing level", () => {
      const { level: _removed, ...rest } = BASE;
      fails(ingestEventSchema, rest);
    });

    it("rejects missing message", () => {
      const { message: _removed, ...rest } = BASE;
      fails(ingestEventSchema, rest);
    });
  });

  describe("timestamp validation", () => {
    it("accepts a valid ISO-8601 datetime with milliseconds", () => {
      const r = ok(ingestEventSchema, { ...BASE, timestamp: "2026-06-10T12:00:00.000Z" });
      expect(r.timestamp).toBe("2026-06-10T12:00:00.000Z");
    });

    it("accepts a valid ISO-8601 datetime without milliseconds", () => {
      const r = ok(ingestEventSchema, { ...BASE, timestamp: "2026-06-10T12:00:00Z" });
      expect(r.timestamp).toBe("2026-06-10T12:00:00Z");
    });

    it("rejects a date-only string", () => {
      fails(ingestEventSchema, { ...BASE, timestamp: "2026-06-10" });
    });

    it("rejects a non-date string", () => {
      fails(ingestEventSchema, { ...BASE, timestamp: "yesterday" });
    });

    it("rejects a numeric timestamp", () => {
      fails(ingestEventSchema, { ...BASE, timestamp: 1_700_000_000_000 });
    });
  });

  describe("level enum validation", () => {
    it("accepts 'debug'", () => {
      expect(ok(ingestEventSchema, { ...BASE, level: "debug" }).level).toBe("debug");
    });

    it("accepts 'info'", () => {
      expect(ok(ingestEventSchema, { ...BASE, level: "info" }).level).toBe("info");
    });

    it("accepts 'warn'", () => {
      expect(ok(ingestEventSchema, { ...BASE, level: "warn" }).level).toBe("warn");
    });

    it("accepts 'error'", () => {
      expect(ok(ingestEventSchema, { ...BASE, level: "error" }).level).toBe("error");
    });

    it("rejects 'WARN' (uppercase)", () => {
      fails(ingestEventSchema, { ...BASE, level: "WARN" });
    });

    it("rejects 'trace' (not in enum)", () => {
      fails(ingestEventSchema, { ...BASE, level: "trace" });
    });

    it("rejects 'verbose' (not in enum)", () => {
      fails(ingestEventSchema, { ...BASE, level: "verbose" });
    });
  });

  describe("service field validation", () => {
    it("accepts service at exactly 1 character (minimum)", () => {
      const r = ok(ingestEventSchema, { ...BASE, service: "a" });
      expect(r.service).toBe("a");
    });

    it("accepts service at exactly 64 characters (maximum)", () => {
      const s = "s".repeat(64);
      const r = ok(ingestEventSchema, { ...BASE, service: s });
      expect(r.service).toBe(s);
    });

    it("rejects empty service string (min 1)", () => {
      fails(ingestEventSchema, { ...BASE, service: "" });
    });

    it("rejects service exceeding 64 characters", () => {
      fails(ingestEventSchema, { ...BASE, service: "s".repeat(65) });
    });
  });

  describe("message field validation", () => {
    it("accepts an empty message string", () => {
      const r = ok(ingestEventSchema, { ...BASE, message: "" });
      expect(r.message).toBe("");
    });

    it("accepts a message at exactly 32768 characters (maximum)", () => {
      const r = ok(ingestEventSchema, { ...BASE, message: "m".repeat(32_768) });
      expect(r.message).toHaveLength(32_768);
    });

    it("rejects message exceeding 32768 characters", () => {
      fails(ingestEventSchema, { ...BASE, message: "m".repeat(32_769) });
    });

    it("accepts Unicode message content", () => {
      const r = ok(ingestEventSchema, { ...BASE, message: "Error: 日本語テスト 🔥" });
      expect(r.message).toContain("日本語");
    });
  });

  describe("traceId field", () => {
    it("accepts an explicit traceId string", () => {
      const r = ok(ingestEventSchema, { ...BASE, traceId: "trace-abc-123" });
      expect(r.traceId).toBe("trace-abc-123");
    });

    it("accepts an empty string traceId explicitly", () => {
      const r = ok(ingestEventSchema, { ...BASE, traceId: "" });
      expect(r.traceId).toBe("");
    });

    it("defaults traceId to empty string when absent", () => {
      const r = ok(ingestEventSchema, BASE);
      expect(r.traceId).toBe("");
    });
  });

  describe("metadata field", () => {
    it("accepts a non-empty metadata record", () => {
      const r = ok(ingestEventSchema, {
        ...BASE,
        metadata: { userId: "u-1", requestId: "r-2", retries: 3 },
      });
      expect(r.metadata["userId"]).toBe("u-1");
    });

    it("defaults metadata to empty object when absent", () => {
      const r = ok(ingestEventSchema, BASE);
      expect(r.metadata).toEqual({});
    });

    it("accepts deeply nested metadata", () => {
      const r = ok(ingestEventSchema, {
        ...BASE,
        metadata: { context: { request: { headers: { "x-trace": "t1" } } } },
      });
      expect(r.metadata["context"]).toBeDefined();
    });

    it("accepts metadata with array values", () => {
      const r = ok(ingestEventSchema, {
        ...BASE,
        metadata: { tags: ["slow", "timeout"] },
      });
      expect(r.metadata["tags"]).toEqual(["slow", "timeout"]);
    });

    it("rejects metadata as an array (must be a record)", () => {
      fails(ingestEventSchema, { ...BASE, metadata: [1, 2, 3] });
    });

    it("rejects metadata as a string", () => {
      fails(ingestEventSchema, { ...BASE, metadata: "raw-string" });
    });

    it("rejects metadata as a number", () => {
      fails(ingestEventSchema, { ...BASE, metadata: 42 });
    });
  });

  describe("full valid event with all fields explicitly set", () => {
    it("accepts a fully-specified ingest event", () => {
      const r = ok(ingestEventSchema, {
        timestamp: "2026-03-01T00:00:00.000Z",
        traceId: "t-xyz",
        service: "payments",
        level: "error",
        message: "Payment gateway timeout",
        metadata: { amount: 99.99, currency: "USD", attempt: 2 },
      });
      expect(r.traceId).toBe("t-xyz");
      expect(r.level).toBe("error");
      expect(r.metadata["amount"]).toBe(99.99);
    });
  });
});
