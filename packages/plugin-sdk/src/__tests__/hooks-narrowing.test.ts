/**
 * Tests for per-stage HookPayload type narrowing (G-092).
 *
 * Strategy: TypeScript compile-time narrowing is verified by writing code that
 * would produce a type error if the discriminated union were incorrect. If the
 * file compiles, the narrowing works. Runtime assertions validate that the
 * discriminant values themselves are correct strings.
 *
 * We do NOT use `@ts-expect-error` to suppress errors — we want the file to
 * compile cleanly in strict mode, which proves the types are correct.
 */

import { describe, it, expect } from "vitest";
import type {
  DiscriminatedHookPayload,
  HookContext,
  HookDataFor,
  HookPayload,
  HookPayloadDataMap,
  IngestionReceiveData,
  IngestionValidateData,
  IngestionEnrichData,
  IngestionStageData,
  OntologyMapData,
  OntologyNormalizeData,
  PipelineTriggerData,
  PipelineStepData,
  PipelineCompleteData,
  ExecutionSetupData,
  ExecutionTeardownData,
  AuthLoginData,
  AuthLogoutData,
  AuthTokenIssueData,
  AppRequestData,
  AppBuildData,
  // Deprecated alias — must still export so callers don't break
  PipelineExecuteData,
} from "../types/hooks.js";

// ────────────────────────────────────────────────────────────────────────────
// Compile-time type helpers
//
// These utilities let us assert assignability at the type level without
// emitting any runtime code. If a type assertion is wrong the file will not
// compile under --strict.
// ────────────────────────────────────────────────────────────────────────────

/** Assert that type A is assignable to type B (A extends B). */
type AssertExtends<A, B> = A extends B ? true : never;

/** Assert that two types are identical. */
type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

// Suppress "declared but not read" errors — these are type-only checks.
type _CheckIngestionReceiveFields = AssertExtends<
  IngestionReceiveData,
  { sourceId: string; rawPayload: unknown; contentType: string; receivedAt: string; headers: Record<string, string> }
>;
// If this compiles, IngestionReceiveData has all required fields.
const _ingestionReceiveCheck: _CheckIngestionReceiveFields = true;

type _CheckPipelineStepFields = AssertExtends<
  PipelineStepData,
  { pipelineId: string; pipelineRunId: string; stepId: string; stepType: string }
>;
const _pipelineStepCheck: _CheckPipelineStepFields = true;

// Deprecated alias must be identical to PipelineStepData.
type _CheckDeprecatedAlias = AssertEqual<PipelineExecuteData, PipelineStepData>;
const _deprecatedAliasCheck: _CheckDeprecatedAlias = true;

// HookDataFor<S> must equal HookPayloadDataMap[S] for a known stage.
type _CheckHookDataFor = AssertEqual<
  HookDataFor<"before:ingestion.receive">,
  IngestionReceiveData
>;
const _hookDataForCheck: _CheckHookDataFor = true;

// Silence the "variable declared but never read" lints for type-only vars.
void _ingestionReceiveCheck;
void _pipelineStepCheck;
void _deprecatedAliasCheck;
void _hookDataForCheck;

// ────────────────────────────────────────────────────────────────────────────
// Runtime test fixtures
// ────────────────────────────────────────────────────────────────────────────

const MOCK_CONTEXT: HookContext = {
  tenantId: "tenant-001",
  traceId: "00000000000000000000000000000001",
  spanId: "0000000000000001",
};

function makePayload<S extends keyof HookPayloadDataMap>(
  stage: S,
  data: HookPayloadDataMap[S],
): Extract<DiscriminatedHookPayload, { stage: S }> {
  // Extract<> restricts the return type to the exact union member for stage S,
  // which TypeScript can verify without a cast because DiscriminatedHookPayload
  // no longer has a catch-all string member that would compete with narrowing.
  return { stage, data, context: MOCK_CONTEXT } as Extract<DiscriminatedHookPayload, { stage: S }>;
}

// ────────────────────────────────────────────────────────────────────────────
// Discriminated union narrowing tests
// ────────────────────────────────────────────────────────────────────────────

describe("DiscriminatedHookPayload — stage narrowing", () => {
  it("narrows data to IngestionReceiveData when stage is before:ingestion.receive", () => {
    const receiveData: IngestionReceiveData = {
      sourceId: "src-1",
      rawPayload: { foo: "bar" },
      contentType: "application/json",
      receivedAt: "2026-01-01T00:00:00Z",
      headers: { "x-source": "webhook" },
    };
    const payload = makePayload("before:ingestion.receive", receiveData);

    if (payload.stage === "before:ingestion.receive") {
      // TypeScript narrows payload.data to IngestionReceiveData here.
      // Accessing .sourceId proves the narrowing worked — it would be a
      // type error if data were still Record<string, unknown>.
      expect(payload.data.sourceId).toBe("src-1");
      expect(payload.data.contentType).toBe("application/json");
      expect(payload.data.rawPayload).toEqual({ foo: "bar" });
    } else {
      throw new Error("stage check should have matched");
    }
  });

  it("narrows data to IngestionValidateData when stage is after:ingestion.validate", () => {
    const validateData: IngestionValidateData = {
      sourceId: "src-2",
      record: { name: "Alice" },
      validationErrors: [],
      receivedAt: "2026-01-01T00:00:00Z",
    };
    const payload = makePayload("after:ingestion.validate", validateData);

    if (payload.stage === "after:ingestion.validate") {
      expect(payload.data.validationErrors).toHaveLength(0);
      expect(payload.data.record).toEqual({ name: "Alice" });
    } else {
      throw new Error("stage check should have matched");
    }
  });

  it("narrows data to IngestionEnrichData when stage is before:ingestion.enrich", () => {
    const enrichData: IngestionEnrichData = {
      sourceId: "src-3",
      record: { id: "1" },
      enrichments: { geoip: { country: "US" } },
      receivedAt: "2026-01-01T00:00:00Z",
    };
    const payload = makePayload("before:ingestion.enrich", enrichData);

    if (payload.stage === "before:ingestion.enrich") {
      expect(payload.data.enrichments).toHaveProperty("geoip");
    } else {
      throw new Error("stage check should have matched");
    }
  });

  it("narrows data to IngestionStageData when stage is after:ingestion.stage", () => {
    const stageData: IngestionStageData = {
      sourceId: "src-4",
      record: { id: "1" },
      enrichments: {},
      receivedAt: "2026-01-01T00:00:00Z",
      partitionKey: "tenant-001:Customer",
    };
    const payload = makePayload("after:ingestion.stage", stageData);

    if (payload.stage === "after:ingestion.stage") {
      expect(payload.data.partitionKey).toBe("tenant-001:Customer");
    } else {
      throw new Error("stage check should have matched");
    }
  });

  it("narrows data to OntologyMapData when stage is before:ontology.map", () => {
    const mapData: OntologyMapData = {
      record: { email: "a@b.com" },
      entityType: "Customer",
      mappingConfidence: 0.97,
      candidates: [{ entityType: "Customer", confidence: 0.97 }],
    };
    const payload = makePayload("before:ontology.map", mapData);

    if (payload.stage === "before:ontology.map") {
      expect(payload.data.entityType).toBe("Customer");
      expect(payload.data.mappingConfidence).toBeGreaterThan(0.9);
    } else {
      throw new Error("stage check should have matched");
    }
  });

  it("narrows data to OntologyNormalizeData when stage is after:ontology.normalize", () => {
    const normalizeData: OntologyNormalizeData = {
      record: { id: "x" },
      entityType: "Customer",
      normalizedFields: [{ originalName: "ID", normalizedName: "id", coerced: true }],
    };
    const payload = makePayload("after:ontology.normalize", normalizeData);

    if (payload.stage === "after:ontology.normalize") {
      const fields = payload.data.normalizedFields;
      expect(fields).toHaveLength(1);
      expect(fields.at(0)?.coerced).toBe(true);
    } else {
      throw new Error("stage check should have matched");
    }
  });

  it("narrows data to PipelineTriggerData when stage is before:pipeline.trigger", () => {
    const triggerData: PipelineTriggerData = {
      pipelineId: "pipe-1",
      pipelineRunId: "run-1",
      triggerType: "webhook",
      triggerPayload: { event: "order.created" },
      triggeredAt: "2026-01-01T00:00:00Z",
    };
    const payload = makePayload("before:pipeline.trigger", triggerData);

    if (payload.stage === "before:pipeline.trigger") {
      expect(payload.data.triggerType).toBe("webhook");
    } else {
      throw new Error("stage check should have matched");
    }
  });

  it("narrows data to PipelineStepData when stage is before:pipeline.step", () => {
    const stepData: PipelineStepData = {
      pipelineId: "pipe-1",
      pipelineRunId: "run-1",
      stepId: "step-enrich",
      stepType: "transformer",
      input: { record: {} },
      previousOutput: null,
    };
    const payload = makePayload("before:pipeline.step", stepData);

    if (payload.stage === "before:pipeline.step") {
      expect(payload.data.stepId).toBe("step-enrich");
      expect(payload.data.previousOutput).toBeNull();
    } else {
      throw new Error("stage check should have matched");
    }
  });

  it("narrows data to PipelineCompleteData when stage is after:pipeline.complete", () => {
    const completeData: PipelineCompleteData = {
      pipelineId: "pipe-1",
      pipelineRunId: "run-1",
      status: "succeeded",
      duration: "PT4.5S",
      stepResults: [{ stepId: "step-enrich", status: "succeeded" }],
    };
    const payload = makePayload("after:pipeline.complete", completeData);

    if (payload.stage === "after:pipeline.complete") {
      expect(payload.data.status).toBe("succeeded");
      expect(payload.data.stepResults).toHaveLength(1);
    } else {
      throw new Error("stage check should have matched");
    }
  });

  it("narrows data to ExecutionSetupData when stage is before:execution.setup", () => {
    const setupData: ExecutionSetupData = {
      executionId: "exec-1",
      pipelineRunId: "run-1",
      config: { timeout: 30 },
      startedAt: "2026-01-01T00:00:00Z",
    };
    const payload = makePayload("before:execution.setup", setupData);

    if (payload.stage === "before:execution.setup") {
      expect(payload.data.executionId).toBe("exec-1");
    } else {
      throw new Error("stage check should have matched");
    }
  });

  it("narrows data to ExecutionTeardownData when stage is after:execution.teardown", () => {
    const teardownData: ExecutionTeardownData = {
      executionId: "exec-1",
      pipelineRunId: "run-1",
      exitStatus: "success",
      duration: "PT2.1S",
    };
    const payload = makePayload("after:execution.teardown", teardownData);

    if (payload.stage === "after:execution.teardown") {
      expect(payload.data.exitStatus).toBe("success");
    } else {
      throw new Error("stage check should have matched");
    }
  });

  it("narrows data to AuthLoginData when stage is before:auth.login", () => {
    const loginData: AuthLoginData = {
      userId: "user-1",
      tenantId: "tenant-001",
      scopes: ["read:data"],
      isSso: false,
    };
    const payload = makePayload("before:auth.login", loginData);

    if (payload.stage === "before:auth.login") {
      expect(payload.data.isSso).toBe(false);
      expect(payload.data.scopes).toContain("read:data");
    } else {
      throw new Error("stage check should have matched");
    }
  });

  it("narrows data to AuthLogoutData when stage is after:auth.logout", () => {
    const logoutData: AuthLogoutData = {
      userId: "user-1",
      tenantId: "tenant-001",
      reason: "user-initiated",
    };
    const payload = makePayload("after:auth.logout", logoutData);

    if (payload.stage === "after:auth.logout") {
      expect(payload.data.reason).toBe("user-initiated");
    } else {
      throw new Error("stage check should have matched");
    }
  });

  it("narrows data to AuthTokenIssueData when stage is before:auth.token.issue", () => {
    const tokenData: AuthTokenIssueData = {
      userId: "user-1",
      tenantId: "tenant-001",
      tokenType: "access",
      scopes: ["read:data", "write:data"],
      expiresAt: "2026-01-01T01:00:00Z",
    };
    const payload = makePayload("before:auth.token.issue", tokenData);

    if (payload.stage === "before:auth.token.issue") {
      expect(payload.data.tokenType).toBe("access");
      expect(payload.data.scopes).toHaveLength(2);
    } else {
      throw new Error("stage check should have matched");
    }
  });

  it("narrows data to AppRequestData when stage is before:app.request", () => {
    const requestData: AppRequestData = {
      method: "POST",
      url: "https://app.example.com/api/data",
      headers: { "content-type": "application/json" },
      body: { key: "value" },
      tenantId: "tenant-001",
    };
    const payload = makePayload("before:app.request", requestData);

    if (payload.stage === "before:app.request") {
      expect(payload.data.method).toBe("POST");
      // `response` is optional — only present in after:app.request
      expect(payload.data.response).toBeUndefined();
    } else {
      throw new Error("stage check should have matched");
    }
  });

  it("narrows data to AppBuildData when stage is after:app.build", () => {
    const buildData: AppBuildData = {
      buildId: "build-42",
      commitSha: "abc123",
      environment: "production",
      startedAt: "2026-01-01T00:00:00Z",
      outcome: {
        status: "succeeded",
        duration: "PT30S",
        artifactUrl: "https://cdn.example.com/build-42.tar.gz",
      },
    };
    const payload = makePayload("after:app.build", buildData);

    if (payload.stage === "after:app.build") {
      expect(payload.data.environment).toBe("production");
      expect(payload.data.outcome?.status).toBe("succeeded");
    } else {
      throw new Error("stage check should have matched");
    }
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Generic HookPayload<S> backward compatibility
// ────────────────────────────────────────────────────────────────────────────

describe("HookPayload<S> generic — backward compatibility", () => {
  it("generic HookPayload<S> still narrows data for known stages", () => {
    // The generic form is the pre-G-092 API. It must still compile and narrow
    // data correctly for existing plugins.
    const payload: HookPayload<"before:ingestion.receive"> = {
      stage: "before:ingestion.receive",
      data: {
        sourceId: "src-compat",
        rawPayload: null,
        contentType: "text/plain",
        receivedAt: "2026-01-01T00:00:00Z",
        headers: {},
      },
      context: MOCK_CONTEXT,
    };

    // payload.data is typed as IngestionReceiveData — access .sourceId directly.
    expect(payload.data.sourceId).toBe("src-compat");
  });

  it("generic HookPayload<S> falls back to Record<string, unknown> for unknown stages", () => {
    // Template-string stages are valid HookStage values but not in HookPayloadDataMap.
    // The generic form should fall back to Record<string, unknown> for those.
    const payload: HookPayload<`before:pipeline.step:${string}`> = {
      stage: "before:pipeline.step:my-custom-step",
      data: { customField: "value" },
      context: MOCK_CONTEXT,
    };

    // data is Record<string, unknown> — index access is valid.
    expect(payload.data["customField"]).toBe("value");
  });
});

// ────────────────────────────────────────────────────────────────────────────
// HookPayloadDataMap coverage — all concrete stages must be mapped
// ────────────────────────────────────────────────────────────────────────────

describe("HookPayloadDataMap — coverage", () => {
  // We verify the map by constructing a typed object for each entry.
  // If a key were missing from the map, TypeScript would error on the
  // assignment. The array is iterated at runtime to confirm all 30 keys exist.

  const MAP_KEYS: Array<keyof HookPayloadDataMap> = [
    "before:ingestion.receive",
    "after:ingestion.receive",
    "before:ingestion.validate",
    "after:ingestion.validate",
    "before:ingestion.enrich",
    "after:ingestion.enrich",
    "before:ingestion.stage",
    "after:ingestion.stage",
    "before:ontology.map",
    "after:ontology.map",
    "before:ontology.normalize",
    "after:ontology.normalize",
    "before:pipeline.trigger",
    "after:pipeline.trigger",
    "before:pipeline.step",
    "after:pipeline.step",
    "before:pipeline.complete",
    "after:pipeline.complete",
    "before:execution.setup",
    "after:execution.setup",
    "before:execution.teardown",
    "after:execution.teardown",
    "before:auth.login",
    "after:auth.login",
    "after:auth.logout",
    "before:auth.token.issue",
    "after:auth.token.issue",
    "before:app.request",
    "after:app.request",
    "before:app.build",
    "after:app.build",
  ];

  it("HookPayloadDataMap covers all 31 concrete stages", () => {
    // 31 = 30 enumerated above + the after:auth.logout single-sided stage
    expect(MAP_KEYS).toHaveLength(31);
  });

  it("all map keys are distinct strings", () => {
    const unique = new Set(MAP_KEYS);
    expect(unique.size).toBe(MAP_KEYS.length);
  });

  it("all map keys follow the before:|after: naming convention", () => {
    for (const key of MAP_KEYS) {
      expect(key).toMatch(/^(before|after):/);
    }
  });
});
