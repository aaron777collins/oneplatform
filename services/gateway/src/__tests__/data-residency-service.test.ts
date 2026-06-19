// Unit tests for DataResidencyService, data residency routes, and data residency middleware.
//
// All external I/O (repositories, logger) is mocked so tests run without
// a real database or network.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  createDataResidencyService,
  DATA_REGIONS,
  REGION_METADATA,
} from "../services/data-residency-service.js";
import type { DataResidencyServiceDeps } from "../services/data-residency-service.js";
import type {
  DataResidencyPolicyRow,
  DataTransferRuleRow,
  DataLocationLogRow,
  DataRegion,
} from "../repositories/types.js";
import { createDataResidencyRoutes } from "../routes/data-residency.js";
import { ForbiddenError, NotFoundError, ConflictError, ValidationError } from "@oneplatform/core";
import type { AppVariables } from "@oneplatform/core";
import { errorHandlerMiddleware } from "@oneplatform/core";
import { dataResidencyMiddleware } from "@oneplatform/core";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePolicyRow(overrides: Partial<DataResidencyPolicyRow> = {}): DataResidencyPolicyRow {
  return {
    id: "policy-001",
    tenant_id: "tenant-1",
    region: "US_EAST",
    storage_class: "standard",
    replication_policy: "single_region",
    created_at: new Date("2024-01-01T00:00:00Z"),
    updated_at: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeTransferRuleRow(overrides: Partial<DataTransferRuleRow> = {}): DataTransferRuleRow {
  return {
    id: "rule-001",
    source_region: "US_EAST",
    target_region: "EU_WEST",
    policy: "allow",
    justification_required: false,
    created_at: new Date("2024-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeLocationLogRow(overrides: Partial<DataLocationLogRow> = {}): DataLocationLogRow {
  return {
    id: "log-001",
    record_id: "record-1",
    tenant_id: "tenant-1",
    region: "US_EAST",
    service: "gateway-service",
    operation: "access",
    actor_id: "user-1",
    metadata: null,
    timestamp: new Date("2024-01-01T00:00:00Z"),
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

function makeDeps(overrides: {
  policyRepo?: Partial<DataResidencyServiceDeps["policyRepo"]>;
  transferRuleRepo?: Partial<DataResidencyServiceDeps["transferRuleRepo"]>;
  locationLogRepo?: Partial<DataResidencyServiceDeps["locationLogRepo"]>;
} = {}): DataResidencyServiceDeps {
  const policyRepo = {
    upsert: vi.fn().mockResolvedValue(makePolicyRow()),
    findByTenantId: vi.fn().mockResolvedValue(makePolicyRow()),
    deleteByTenantId: vi.fn().mockResolvedValue(true),
    findByRegion: vi.fn().mockResolvedValue([makePolicyRow()]),
    findAll: vi.fn().mockResolvedValue([makePolicyRow()]),
    ...overrides.policyRepo,
  };

  const transferRuleRepo = {
    create: vi.fn().mockResolvedValue(makeTransferRuleRow()),
    findByRegions: vi.fn().mockResolvedValue(makeTransferRuleRow()),
    findAll: vi.fn().mockResolvedValue([makeTransferRuleRow()]),
    findBySourceRegion: vi.fn().mockResolvedValue([makeTransferRuleRow()]),
    deleteById: vi.fn().mockResolvedValue(true),
    ...overrides.transferRuleRepo,
  };

  const locationLogRepo = {
    create: vi.fn().mockResolvedValue(makeLocationLogRow()),
    findByTenantId: vi.fn().mockResolvedValue([makeLocationLogRow()]),
    countViolationsByRegion: vi.fn().mockResolvedValue([]),
    ...overrides.locationLogRepo,
  };

  return {
    policyRepo: policyRepo as never,
    transferRuleRepo: transferRuleRepo as never,
    locationLogRepo: locationLogRepo as never,
    logger: makeLogger() as never,
  };
}

// ---------------------------------------------------------------------------
// Route test helpers
// ---------------------------------------------------------------------------

function makeTestApp(
  deps: DataResidencyServiceDeps,
  userContext: Partial<AppVariables["user"]> = {},
) {
  const svc = createDataResidencyService(deps);
  const app = new Hono<{ Variables: AppVariables }>();

  const user: AppVariables["user"] = {
    userId: "user-1",
    tenantId: "tenant-1",
    roles: ["admin"],
    scopes: ["admin"],
    isGuest: false,
    isService: false,
    emailVerified: true,
    ...userContext,
  };

  app.use("*", async (c, next) => {
    c.set("user", user);
    c.set("requestId", "test-request-id");
    await next();
  });

  const routes = createDataResidencyRoutes({ dataResidencyService: svc });
  app.route("/", routes);
  app.onError(errorHandlerMiddleware());

  return app;
}

// ===========================================================================
// DataResidencyService — listRegions()
// ===========================================================================

describe("DataResidencyService.listRegions()", () => {
  it("returns all 6 available regions", () => {
    const deps = makeDeps();
    const svc = createDataResidencyService(deps);

    const regions = svc.listRegions();

    expect(regions).toHaveLength(6);
    expect(regions.map((r) => r.region)).toEqual([
      "US_EAST",
      "US_WEST",
      "EU_WEST",
      "EU_CENTRAL",
      "AP_SOUTHEAST",
      "AP_NORTHEAST",
    ]);
  });

  it("includes name, location, and jurisdiction for each region", () => {
    const deps = makeDeps();
    const svc = createDataResidencyService(deps);

    const regions = svc.listRegions();
    for (const region of regions) {
      expect(region.name).toBeTruthy();
      expect(region.location).toBeTruthy();
      expect(region.jurisdiction).toBeTruthy();
    }
  });
});

// ===========================================================================
// DataResidencyService — isValidRegion()
// ===========================================================================

describe("DataResidencyService.isValidRegion()", () => {
  it("returns true for valid regions", () => {
    const deps = makeDeps();
    const svc = createDataResidencyService(deps);

    for (const region of DATA_REGIONS) {
      expect(svc.isValidRegion(region)).toBe(true);
    }
  });

  it("returns false for invalid regions", () => {
    const deps = makeDeps();
    const svc = createDataResidencyService(deps);

    expect(svc.isValidRegion("INVALID")).toBe(false);
    expect(svc.isValidRegion("")).toBe(false);
    expect(svc.isValidRegion("us_east")).toBe(false);
  });
});

// ===========================================================================
// DataResidencyService — getPolicy()
// ===========================================================================

describe("DataResidencyService.getPolicy()", () => {
  it("returns the policy when it exists", async () => {
    const deps = makeDeps();
    const svc = createDataResidencyService(deps);

    const policy = await svc.getPolicy("tenant-1");

    expect(policy).not.toBeNull();
    expect(policy?.region).toBe("US_EAST");
    expect(deps.policyRepo.findByTenantId).toHaveBeenCalledWith("tenant-1");
  });

  it("returns null when no policy exists", async () => {
    const deps = makeDeps({
      policyRepo: { findByTenantId: vi.fn().mockResolvedValue(null) },
    });
    const svc = createDataResidencyService(deps);

    const policy = await svc.getPolicy("tenant-1");

    expect(policy).toBeNull();
  });
});

// ===========================================================================
// DataResidencyService — upsertPolicy()
// ===========================================================================

describe("DataResidencyService.upsertPolicy()", () => {
  it("creates a new policy and emits an audit event", async () => {
    const deps = makeDeps();
    const svc = createDataResidencyService(deps);

    const policy = await svc.upsertPolicy("tenant-1", "EU_WEST");

    expect(deps.policyRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: "tenant-1",
        region: "EU_WEST",
      }),
    );
    expect(deps.logger.audit).toHaveBeenCalledOnce();
    expect(policy.id).toBe("policy-001");
  });

  it("passes optional storageClass and replicationPolicy", async () => {
    const deps = makeDeps();
    const svc = createDataResidencyService(deps);

    await svc.upsertPolicy("tenant-1", "US_EAST", {
      storageClass: "archive",
      replicationPolicy: "multi_az",
    });

    expect(deps.policyRepo.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        storage_class: "archive",
        replication_policy: "multi_az",
      }),
    );
  });
});

// ===========================================================================
// DataResidencyService — deletePolicy()
// ===========================================================================

describe("DataResidencyService.deletePolicy()", () => {
  it("deletes the policy and logs audit event", async () => {
    const deps = makeDeps();
    const svc = createDataResidencyService(deps);

    await svc.deletePolicy("tenant-1");

    expect(deps.policyRepo.deleteByTenantId).toHaveBeenCalledWith("tenant-1");
    expect(deps.logger.audit).toHaveBeenCalledOnce();
  });

  it("throws NotFoundError when policy does not exist", async () => {
    const deps = makeDeps({
      policyRepo: { deleteByTenantId: vi.fn().mockResolvedValue(false) },
    });
    const svc = createDataResidencyService(deps);

    await expect(svc.deletePolicy("tenant-1")).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ===========================================================================
// DataResidencyService — createTransferRule()
// ===========================================================================

describe("DataResidencyService.createTransferRule()", () => {
  it("creates a new rule with valid regions", async () => {
    const deps = makeDeps();
    const svc = createDataResidencyService(deps);

    const rule = await svc.createTransferRule("US_EAST", "EU_WEST", "allow");

    expect(deps.transferRuleRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        source_region: "US_EAST",
        target_region: "EU_WEST",
        policy: "allow",
      }),
    );
    expect(rule.id).toBe("rule-001");
  });

  it("throws ValidationError when source and target are the same", async () => {
    const deps = makeDeps();
    const svc = createDataResidencyService(deps);

    await expect(
      svc.createTransferRule("US_EAST", "US_EAST", "allow"),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws ConflictError when a duplicate rule already exists", async () => {
    const deps = makeDeps({
      transferRuleRepo: {
        create: vi.fn().mockRejectedValue(new Error("duplicate key")),
      },
    });
    const svc = createDataResidencyService(deps);

    await expect(
      svc.createTransferRule("US_EAST", "EU_WEST", "allow"),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("passes justificationRequired flag to repository", async () => {
    const deps = makeDeps();
    const svc = createDataResidencyService(deps);

    await svc.createTransferRule("US_EAST", "EU_WEST", "audit", true);

    expect(deps.transferRuleRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        justification_required: true,
      }),
    );
  });
});

// ===========================================================================
// DataResidencyService — deleteTransferRule()
// ===========================================================================

describe("DataResidencyService.deleteTransferRule()", () => {
  it("deletes the rule by ID", async () => {
    const deps = makeDeps();
    const svc = createDataResidencyService(deps);

    await svc.deleteTransferRule("rule-001");

    expect(deps.transferRuleRepo.deleteById).toHaveBeenCalledWith("rule-001");
  });

  it("throws NotFoundError when rule does not exist", async () => {
    const deps = makeDeps({
      transferRuleRepo: { deleteById: vi.fn().mockResolvedValue(false) },
    });
    const svc = createDataResidencyService(deps);

    await expect(svc.deleteTransferRule("nonexistent")).rejects.toBeInstanceOf(NotFoundError);
  });
});

// ===========================================================================
// DataResidencyService — evaluateTransfer()
// ===========================================================================

describe("DataResidencyService.evaluateTransfer()", () => {
  it("allows same-region transfers without consulting the database", async () => {
    const deps = makeDeps();
    const svc = createDataResidencyService(deps);

    const result = await svc.evaluateTransfer("US_EAST", "US_EAST");

    expect(result.allowed).toBe(true);
    expect(result.policy).toBe("allow");
    expect(deps.transferRuleRepo.findByRegions).not.toHaveBeenCalled();
  });

  it("returns allowed=true for 'allow' rules", async () => {
    const deps = makeDeps({
      transferRuleRepo: {
        findByRegions: vi.fn().mockResolvedValue(
          makeTransferRuleRow({ policy: "allow" }),
        ),
      },
    });
    const svc = createDataResidencyService(deps);

    const result = await svc.evaluateTransfer("US_EAST", "EU_WEST");

    expect(result.allowed).toBe(true);
    expect(result.policy).toBe("allow");
  });

  it("returns allowed=true for 'audit' rules", async () => {
    const deps = makeDeps({
      transferRuleRepo: {
        findByRegions: vi.fn().mockResolvedValue(
          makeTransferRuleRow({ policy: "audit", justification_required: true }),
        ),
      },
    });
    const svc = createDataResidencyService(deps);

    const result = await svc.evaluateTransfer("US_EAST", "EU_WEST");

    expect(result.allowed).toBe(true);
    expect(result.policy).toBe("audit");
    expect(result.justificationRequired).toBe(true);
  });

  it("returns allowed=false for 'deny' rules", async () => {
    const deps = makeDeps({
      transferRuleRepo: {
        findByRegions: vi.fn().mockResolvedValue(
          makeTransferRuleRow({ policy: "deny" }),
        ),
      },
    });
    const svc = createDataResidencyService(deps);

    const result = await svc.evaluateTransfer("US_EAST", "EU_WEST");

    expect(result.allowed).toBe(false);
    expect(result.policy).toBe("deny");
  });

  it("defaults to deny when no rule exists (fail-closed)", async () => {
    const deps = makeDeps({
      transferRuleRepo: {
        findByRegions: vi.fn().mockResolvedValue(null),
      },
    });
    const svc = createDataResidencyService(deps);

    const result = await svc.evaluateTransfer("US_EAST", "AP_SOUTHEAST");

    expect(result.allowed).toBe(false);
    expect(result.policy).toBe("deny");
    expect(result.rule).toBeNull();
  });
});

// ===========================================================================
// DataResidencyService — enforcePolicy()
// ===========================================================================

describe("DataResidencyService.enforcePolicy()", () => {
  it("returns null when tenant has no policy (opt-in model)", async () => {
    const deps = makeDeps({
      policyRepo: { findByTenantId: vi.fn().mockResolvedValue(null) },
    });
    const svc = createDataResidencyService(deps);

    const result = await svc.enforcePolicy("tenant-1", "US_EAST", "gateway");

    expect(result).toBeNull();
  });

  it("allows same-region access and logs the access", async () => {
    const deps = makeDeps({
      policyRepo: {
        findByTenantId: vi.fn().mockResolvedValue(makePolicyRow({ region: "US_EAST" })),
      },
    });
    const svc = createDataResidencyService(deps);

    const result = await svc.enforcePolicy("tenant-1", "US_EAST", "gateway");

    expect(result).toBe("US_EAST");
    expect(deps.locationLogRepo.create).toHaveBeenCalled();
  });

  it("throws ForbiddenError for unauthorized cross-region access", async () => {
    const deps = makeDeps({
      policyRepo: {
        findByTenantId: vi.fn().mockResolvedValue(makePolicyRow({ region: "US_EAST" })),
      },
      transferRuleRepo: {
        findByRegions: vi.fn().mockResolvedValue(null), // No rule = deny
      },
    });
    const svc = createDataResidencyService(deps);

    await expect(
      svc.enforcePolicy("tenant-1", "EU_WEST", "gateway"),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("allows cross-region access when an allow rule exists", async () => {
    const deps = makeDeps({
      policyRepo: {
        findByTenantId: vi.fn().mockResolvedValue(makePolicyRow({ region: "US_EAST" })),
      },
      transferRuleRepo: {
        findByRegions: vi.fn().mockResolvedValue(
          makeTransferRuleRow({ policy: "allow" }),
        ),
      },
    });
    const svc = createDataResidencyService(deps);

    const result = await svc.enforcePolicy("tenant-1", "EU_WEST", "gateway");

    expect(result).toBe("US_EAST");
  });

  it("throws ValidationError when audit rule requires justification but none given", async () => {
    const deps = makeDeps({
      policyRepo: {
        findByTenantId: vi.fn().mockResolvedValue(makePolicyRow({ region: "US_EAST" })),
      },
      transferRuleRepo: {
        findByRegions: vi.fn().mockResolvedValue(
          makeTransferRuleRow({ policy: "audit", justification_required: true }),
        ),
      },
    });
    const svc = createDataResidencyService(deps);

    await expect(
      svc.enforcePolicy("tenant-1", "EU_WEST", "gateway"),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("allows audited cross-region access with justification", async () => {
    const deps = makeDeps({
      policyRepo: {
        findByTenantId: vi.fn().mockResolvedValue(makePolicyRow({ region: "US_EAST" })),
      },
      transferRuleRepo: {
        findByRegions: vi.fn().mockResolvedValue(
          makeTransferRuleRow({ policy: "audit", justification_required: true }),
        ),
      },
    });
    const svc = createDataResidencyService(deps);

    const result = await svc.enforcePolicy("tenant-1", "EU_WEST", "gateway", {
      justification: "Regulatory requirement for cross-border data sharing",
    });

    expect(result).toBe("US_EAST");
    expect(deps.logger.audit).toHaveBeenCalled();
  });

  it("logs cross-region access attempt even when denied", async () => {
    const deps = makeDeps({
      policyRepo: {
        findByTenantId: vi.fn().mockResolvedValue(makePolicyRow({ region: "US_EAST" })),
      },
      transferRuleRepo: {
        findByRegions: vi.fn().mockResolvedValue(null),
      },
    });
    const svc = createDataResidencyService(deps);

    await expect(
      svc.enforcePolicy("tenant-1", "EU_WEST", "gateway"),
    ).rejects.toThrow();

    // Cross-region attempt should still be logged for audit
    expect(deps.locationLogRepo.create).toHaveBeenCalled();
  });
});

// ===========================================================================
// DataResidencyService — logDataLocation()
// ===========================================================================

describe("DataResidencyService.logDataLocation()", () => {
  it("creates an audit log entry with all fields", async () => {
    const deps = makeDeps();
    const svc = createDataResidencyService(deps);

    const log = await svc.logDataLocation(
      "record-123",
      "tenant-1",
      "US_EAST",
      "gateway-service",
      { operation: "write", actorId: "user-1", metadata: { key: "value" } },
    );

    expect(deps.locationLogRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        record_id: "record-123",
        tenant_id: "tenant-1",
        region: "US_EAST",
        service: "gateway-service",
        operation: "write",
        actor_id: "user-1",
        metadata: { key: "value" },
      }),
    );
    expect(log.id).toBe("log-001");
  });

  it("defaults optional fields when not provided", async () => {
    const deps = makeDeps();
    const svc = createDataResidencyService(deps);

    await svc.logDataLocation("record-123", "tenant-1", "US_EAST", "gateway-service");

    expect(deps.locationLogRepo.create).toHaveBeenCalledWith({
      record_id: "record-123",
      tenant_id: "tenant-1",
      region: "US_EAST",
      service: "gateway-service",
    });
  });
});

// ===========================================================================
// DataResidencyService — queryAuditLog()
// ===========================================================================

describe("DataResidencyService.queryAuditLog()", () => {
  it("delegates to repository with all options", async () => {
    const deps = makeDeps();
    const svc = createDataResidencyService(deps);

    await svc.queryAuditLog("tenant-1", {
      region: "US_EAST",
      service: "gateway-service",
      startTime: new Date("2024-01-01"),
      endTime: new Date("2024-12-31"),
      cursor: "c",
      limit: 10,
    });

    expect(deps.locationLogRepo.findByTenantId).toHaveBeenCalledWith("tenant-1", {
      region: "US_EAST",
      service: "gateway-service",
      startTime: new Date("2024-01-01"),
      endTime: new Date("2024-12-31"),
      cursor: "c",
      limit: 10,
    });
  });
});

// ===========================================================================
// DataResidencyService — checkCompliance()
// ===========================================================================

describe("DataResidencyService.checkCompliance()", () => {
  it("returns compliant when no policy exists", async () => {
    const deps = makeDeps({
      policyRepo: { findByTenantId: vi.fn().mockResolvedValue(null) },
    });
    const svc = createDataResidencyService(deps);

    const result = await svc.checkCompliance("tenant-1");

    expect(result.compliant).toBe(true);
    expect(result.assignedRegion).toBeNull();
    expect(result.violations).toHaveLength(0);
  });

  it("returns compliant when all data is in the assigned region", async () => {
    const deps = makeDeps({
      policyRepo: {
        findByTenantId: vi.fn().mockResolvedValue(makePolicyRow({ region: "US_EAST" })),
      },
      locationLogRepo: {
        findByTenantId: vi.fn().mockResolvedValue([
          makeLocationLogRow({ region: "US_EAST" }),
          makeLocationLogRow({ region: "US_EAST" }),
        ]),
        countViolationsByRegion: vi.fn().mockResolvedValue([]),
      },
    });
    const svc = createDataResidencyService(deps);

    const result = await svc.checkCompliance("tenant-1");

    expect(result.compliant).toBe(true);
    expect(result.assignedRegion).toBe("US_EAST");
  });

  it("returns non-compliant with violations when data is in wrong regions", async () => {
    const deps = makeDeps({
      policyRepo: {
        findByTenantId: vi.fn().mockResolvedValue(makePolicyRow({ region: "US_EAST" })),
      },
      locationLogRepo: {
        findByTenantId: vi.fn().mockResolvedValue([
          makeLocationLogRow({ region: "US_EAST" }),
          makeLocationLogRow({ region: "EU_WEST" }),
          makeLocationLogRow({ region: "EU_WEST" }),
          makeLocationLogRow({ region: "AP_SOUTHEAST" }),
        ]),
        countViolationsByRegion: vi.fn().mockResolvedValue([
          { region: "EU_WEST", count: 2 },
          { region: "AP_SOUTHEAST", count: 1 },
        ]),
      },
    });
    const svc = createDataResidencyService(deps);

    const result = await svc.checkCompliance("tenant-1");

    expect(result.compliant).toBe(false);
    expect(result.assignedRegion).toBe("US_EAST");
    expect(result.violations).toHaveLength(2);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        { region: "EU_WEST", count: 2 },
        { region: "AP_SOUTHEAST", count: 1 },
      ]),
    );
  });
});

// ===========================================================================
// DataResidencyService — listTransferRules()
// ===========================================================================

describe("DataResidencyService.listTransferRules()", () => {
  it("delegates to repository", async () => {
    const deps = makeDeps();
    const svc = createDataResidencyService(deps);

    const rules = await svc.listTransferRules();

    expect(deps.transferRuleRepo.findAll).toHaveBeenCalled();
    expect(rules).toHaveLength(1);
  });
});

// ===========================================================================
// Routes — GET /regions
// ===========================================================================

describe("GET /regions", () => {
  it("returns 200 with all available regions", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps);

    const res = await app.fetch(
      new Request("http://localhost/regions", { method: "GET" }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(6);
  });

  it("returns 401 for unauthenticated requests", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps, { tenantId: "" as never });

    const res = await app.fetch(
      new Request("http://localhost/regions", { method: "GET" }),
    );

    expect(res.status).toBe(401);
  });
});

// ===========================================================================
// Routes — GET /policies/:tenantId
// ===========================================================================

describe("GET /policies/:tenantId", () => {
  it("returns 200 with the tenant policy for admin users", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps);

    const res = await app.fetch(
      new Request("http://localhost/policies/tenant-1", { method: "GET" }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { region: string } };
    expect(body.data.region).toBe("US_EAST");
  });

  it("returns 404 when no policy exists", async () => {
    const deps = makeDeps({
      policyRepo: { findByTenantId: vi.fn().mockResolvedValue(null) },
    });
    const app = makeTestApp(deps);

    const res = await app.fetch(
      new Request("http://localhost/policies/tenant-1", { method: "GET" }),
    );

    expect(res.status).toBe(404);
  });

  it("returns 403 when non-admin queries another tenant", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps, { tenantId: "tenant-1", scopes: [] });

    const res = await app.fetch(
      new Request("http://localhost/policies/tenant-other", { method: "GET" }),
    );

    expect(res.status).toBe(403);
  });

  it("allows non-admin to view their own tenant policy", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps, { tenantId: "tenant-1", scopes: [] });

    const res = await app.fetch(
      new Request("http://localhost/policies/tenant-1", { method: "GET" }),
    );

    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// Routes — PUT /policies/:tenantId
// ===========================================================================

describe("PUT /policies/:tenantId", () => {
  it("returns 200 when creating/updating a policy as admin", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps);

    const res = await app.fetch(
      new Request("http://localhost/policies/tenant-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region: "EU_WEST" }),
      }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { tenantId: string } };
    expect(body.data.tenantId).toBe("tenant-1");
  });

  it("returns 403 for non-admin users", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps, { scopes: [] });

    const res = await app.fetch(
      new Request("http://localhost/policies/tenant-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region: "EU_WEST" }),
      }),
    );

    expect(res.status).toBe(403);
  });

  it("returns 422 for invalid region", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps);

    const res = await app.fetch(
      new Request("http://localhost/policies/tenant-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region: "INVALID_REGION" }),
      }),
    );

    expect(res.status).toBe(422);
  });

  it("accepts optional storageClass and replicationPolicy", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps);

    const res = await app.fetch(
      new Request("http://localhost/policies/tenant-1", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          region: "EU_CENTRAL",
          storageClass: "archive",
          replicationPolicy: "multi_az",
        }),
      }),
    );

    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// Routes — DELETE /policies/:tenantId
// ===========================================================================

describe("DELETE /policies/:tenantId", () => {
  it("returns 200 when deleting a policy as admin", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps);

    const res = await app.fetch(
      new Request("http://localhost/policies/tenant-1", { method: "DELETE" }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { deleted: boolean } };
    expect(body.data.deleted).toBe(true);
  });

  it("returns 403 for non-admin users", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps, { scopes: [] });

    const res = await app.fetch(
      new Request("http://localhost/policies/tenant-1", { method: "DELETE" }),
    );

    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// Routes — GET /transfer-rules
// ===========================================================================

describe("GET /transfer-rules", () => {
  it("returns 200 with all rules for admin users", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps);

    const res = await app.fetch(
      new Request("http://localhost/transfer-rules", { method: "GET" }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(1);
  });

  it("returns 403 for non-admin users", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps, { scopes: [] });

    const res = await app.fetch(
      new Request("http://localhost/transfer-rules", { method: "GET" }),
    );

    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// Routes — POST /transfer-rules
// ===========================================================================

describe("POST /transfer-rules", () => {
  it("returns 201 when creating a valid rule as admin", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps);

    const res = await app.fetch(
      new Request("http://localhost/transfer-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceRegion: "US_EAST",
          targetRegion: "EU_WEST",
          policy: "allow",
        }),
      }),
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { sourceRegion: string } };
    expect(body.data.sourceRegion).toBe("US_EAST");
  });

  it("returns 422 for invalid request body", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps);

    const res = await app.fetch(
      new Request("http://localhost/transfer-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceRegion: "INVALID",
          targetRegion: "EU_WEST",
          policy: "allow",
        }),
      }),
    );

    expect(res.status).toBe(422);
  });

  it("returns 403 for non-admin users", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps, { scopes: [] });

    const res = await app.fetch(
      new Request("http://localhost/transfer-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceRegion: "US_EAST",
          targetRegion: "EU_WEST",
          policy: "allow",
        }),
      }),
    );

    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// Routes — DELETE /transfer-rules/:id
// ===========================================================================

describe("DELETE /transfer-rules/:id", () => {
  it("returns 200 when deleting a rule as admin", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps);

    const res = await app.fetch(
      new Request("http://localhost/transfer-rules/rule-001", { method: "DELETE" }),
    );

    expect(res.status).toBe(200);
  });

  it("returns 403 for non-admin users", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps, { scopes: [] });

    const res = await app.fetch(
      new Request("http://localhost/transfer-rules/rule-001", { method: "DELETE" }),
    );

    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// Routes — GET /audit-log
// ===========================================================================

describe("GET /audit-log", () => {
  it("returns 200 with paginated audit log entries", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps);

    const res = await app.fetch(
      new Request("http://localhost/audit-log", { method: "GET" }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; pagination: { nextCursor: string | null } };
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination).toBeDefined();
  });

  it("supports region and service query parameters", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps);

    const res = await app.fetch(
      new Request("http://localhost/audit-log?region=US_EAST&service=gateway-service", {
        method: "GET",
      }),
    );

    expect(res.status).toBe(200);
  });

  it("returns 422 for invalid query parameters", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps);

    const res = await app.fetch(
      new Request("http://localhost/audit-log?region=INVALID_REGION", { method: "GET" }),
    );

    expect(res.status).toBe(422);
  });

  it("returns null nextCursor when fewer rows than limit are returned", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps);

    const res = await app.fetch(
      new Request("http://localhost/audit-log", { method: "GET" }),
    );

    const body = (await res.json()) as { pagination: { nextCursor: string | null } };
    expect(body.pagination.nextCursor).toBeNull();
  });
});

// ===========================================================================
// Routes — GET /compliance/:tenantId
// ===========================================================================

describe("GET /compliance/:tenantId", () => {
  it("returns compliance status for admin user", async () => {
    const deps = makeDeps({
      locationLogRepo: {
        findByTenantId: vi.fn().mockResolvedValue([
          makeLocationLogRow({ region: "US_EAST" }),
        ]),
        countViolationsByRegion: vi.fn().mockResolvedValue([]),
      },
    });
    const app = makeTestApp(deps);

    const res = await app.fetch(
      new Request("http://localhost/compliance/tenant-1", { method: "GET" }),
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { compliant: boolean } };
    expect(body.data.compliant).toBe(true);
  });

  it("returns 403 when non-admin checks another tenant", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps, { tenantId: "tenant-1", scopes: [] });

    const res = await app.fetch(
      new Request("http://localhost/compliance/tenant-other", { method: "GET" }),
    );

    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// Routes — Response shape validation
// ===========================================================================

describe("Response shape", () => {
  it("formats policy dates as ISO strings", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps);

    const res = await app.fetch(
      new Request("http://localhost/policies/tenant-1", { method: "GET" }),
    );

    const body = (await res.json()) as { data: { createdAt: string; updatedAt: string } };
    expect(body.data.createdAt).toBe("2024-01-01T00:00:00.000Z");
    expect(body.data.updatedAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("formats transfer rule createdAt as ISO string", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps);

    const res = await app.fetch(
      new Request("http://localhost/transfer-rules", { method: "GET" }),
    );

    const body = (await res.json()) as { data: Array<{ createdAt: string }> };
    expect(body.data[0]?.createdAt).toBe("2024-01-01T00:00:00.000Z");
  });

  it("formats audit log timestamps as ISO strings", async () => {
    const deps = makeDeps();
    const app = makeTestApp(deps);

    const res = await app.fetch(
      new Request("http://localhost/audit-log", { method: "GET" }),
    );

    const body = (await res.json()) as { data: Array<{ timestamp: string }> };
    expect(body.data[0]?.timestamp).toBe("2024-01-01T00:00:00.000Z");
  });
});

// ===========================================================================
// Middleware — dataResidencyMiddleware
// ===========================================================================

describe("dataResidencyMiddleware", () => {
  function makeMiddlewareApp(
    enforcer: {
      getPolicy: (...args: unknown[]) => Promise<{ region: string } | null>;
      evaluateTransfer: (...args: unknown[]) => Promise<{ allowed: boolean; policy: string; justificationRequired: boolean }>;
      logDataLocation: (...args: unknown[]) => Promise<unknown>;
    },
    options: { enforce?: boolean; serviceRegion?: string } = {},
  ) {
    const app = new Hono<{ Variables: AppVariables }>();

    // Inject user context
    app.use("*", async (c, next) => {
      c.set("user", {
        userId: "user-1",
        tenantId: "tenant-1",
        roles: ["member"],
        scopes: [],
        isGuest: false,
        isService: false,
        emailVerified: true,
      });
      c.set("requestId", "test-request-id");
      await next();
    });

    app.use(
      "*",
      dataResidencyMiddleware({
        enforcer,
        serviceRegion: options.serviceRegion ?? "US_EAST",
        serviceName: "gateway-service",
        ...(options.enforce !== undefined ? { enforce: options.enforce } : {}),
      }),
    );

    app.get("/api/test", (c) => c.json({ ok: true }));
    app.get("/healthz", (c) => c.json({ status: "ok" }));

    return app;
  }

  it("skips health check paths", async () => {
    const enforcer = {
      getPolicy: vi.fn(),
      evaluateTransfer: vi.fn(),
      logDataLocation: vi.fn(),
    };
    const app = makeMiddlewareApp(enforcer);

    const res = await app.fetch(
      new Request("http://localhost/healthz", { method: "GET" }),
    );

    expect(res.status).toBe(200);
    expect(enforcer.getPolicy).not.toHaveBeenCalled();
  });

  it("allows requests when tenant has no policy", async () => {
    const enforcer = {
      getPolicy: vi.fn().mockResolvedValue(null),
      evaluateTransfer: vi.fn(),
      logDataLocation: vi.fn().mockResolvedValue({}),
    };
    const app = makeMiddlewareApp(enforcer);

    const res = await app.fetch(
      new Request("http://localhost/api/test", { method: "GET" }),
    );

    expect(res.status).toBe(200);
  });

  it("allows same-region requests", async () => {
    const enforcer = {
      getPolicy: vi.fn().mockResolvedValue({ region: "US_EAST" }),
      evaluateTransfer: vi.fn(),
      logDataLocation: vi.fn().mockResolvedValue({}),
    };
    const app = makeMiddlewareApp(enforcer, { serviceRegion: "US_EAST" });

    const res = await app.fetch(
      new Request("http://localhost/api/test", { method: "GET" }),
    );

    expect(res.status).toBe(200);
    expect(enforcer.evaluateTransfer).not.toHaveBeenCalled();
  });

  it("blocks cross-region requests when no transfer rule exists and enforce is true", async () => {
    const enforcer = {
      getPolicy: vi.fn().mockResolvedValue({ region: "US_EAST" }),
      evaluateTransfer: vi.fn().mockResolvedValue({
        allowed: false,
        policy: "deny",
        justificationRequired: false,
      }),
      logDataLocation: vi.fn().mockResolvedValue({}),
    };
    const app = makeMiddlewareApp(enforcer, { serviceRegion: "EU_WEST" });

    const res = await app.fetch(
      new Request("http://localhost/api/test", { method: "GET" }),
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  it("allows cross-region requests when transfer rule permits", async () => {
    const enforcer = {
      getPolicy: vi.fn().mockResolvedValue({ region: "US_EAST" }),
      evaluateTransfer: vi.fn().mockResolvedValue({
        allowed: true,
        policy: "allow",
        justificationRequired: false,
      }),
      logDataLocation: vi.fn().mockResolvedValue({}),
    };
    const app = makeMiddlewareApp(enforcer, { serviceRegion: "EU_WEST" });

    const res = await app.fetch(
      new Request("http://localhost/api/test", { method: "GET" }),
    );

    expect(res.status).toBe(200);
  });

  it("allows cross-region requests in audit-only mode even when denied", async () => {
    const enforcer = {
      getPolicy: vi.fn().mockResolvedValue({ region: "US_EAST" }),
      evaluateTransfer: vi.fn().mockResolvedValue({
        allowed: false,
        policy: "deny",
        justificationRequired: false,
      }),
      logDataLocation: vi.fn().mockResolvedValue({}),
    };
    const app = makeMiddlewareApp(enforcer, {
      serviceRegion: "EU_WEST",
      enforce: false,
    });

    const res = await app.fetch(
      new Request("http://localhost/api/test", { method: "GET" }),
    );

    expect(res.status).toBe(200);
  });

  it("logs cross-region access attempts for audit trail", async () => {
    const enforcer = {
      getPolicy: vi.fn().mockResolvedValue({ region: "US_EAST" }),
      evaluateTransfer: vi.fn().mockResolvedValue({
        allowed: true,
        policy: "allow",
        justificationRequired: false,
      }),
      logDataLocation: vi.fn().mockResolvedValue({}),
    };
    const app = makeMiddlewareApp(enforcer, { serviceRegion: "EU_WEST" });

    await app.fetch(
      new Request("http://localhost/api/test", { method: "GET" }),
    );

    expect(enforcer.logDataLocation).toHaveBeenCalledWith(
      "middleware-check",
      "tenant-1",
      "EU_WEST",
      "gateway-service",
      expect.objectContaining({
        operation: "cross_region_access_attempt",
        actorId: "user-1",
      }),
    );
  });

  it("gracefully handles policy lookup failure without blocking requests", async () => {
    const enforcer = {
      getPolicy: vi.fn().mockRejectedValue(new Error("DB down")),
      evaluateTransfer: vi.fn(),
      logDataLocation: vi.fn().mockResolvedValue({}),
    };
    const app = makeMiddlewareApp(enforcer);

    const res = await app.fetch(
      new Request("http://localhost/api/test", { method: "GET" }),
    );

    // Request should proceed even if policy lookup fails
    expect(res.status).toBe(200);
  });
});

// ===========================================================================
// Region metadata coverage
// ===========================================================================

describe("Region metadata", () => {
  it("every DATA_REGION has corresponding REGION_METADATA", () => {
    for (const region of DATA_REGIONS) {
      const meta = REGION_METADATA[region];
      expect(meta).toBeDefined();
      expect(meta.name).toBeTruthy();
      expect(meta.location).toBeTruthy();
      expect(meta.jurisdiction).toBeTruthy();
    }
  });
});
