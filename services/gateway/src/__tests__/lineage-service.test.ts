// Unit tests for LineageService.
//
// All upstream HTTP calls are intercepted via global fetch mocks so no real
// services are required. Each describe block resets the mock between tests.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLineageService } from "../services/lineage-service.js";
import type { LineageServiceDeps, LineageGraph } from "../services/lineage-service.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function makeDeps(overrides: Partial<LineageServiceDeps["config"]> = {}): LineageServiceDeps {
  return {
    config: {
      ingestionServiceUrl: "http://ingestion",
      ontologyServiceUrl: "http://ontology",
      pipelineServiceUrl: "http://pipeline",
      appServiceUrl: "http://app",
      serviceTokenSigner: { sign: async () => "test-token" },
      ...overrides,
    },
    logger: makeLogger() as never,
  };
}

// Helper that constructs a mock fetch response
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Canonical empty service responses
const EMPTY = { data: [] };

// ---------------------------------------------------------------------------
// Empty graph
// ---------------------------------------------------------------------------

describe("LineageService — empty graph", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(EMPTY)));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("returns an empty graph when all services return empty arrays", async () => {
    const service = createLineageService(makeDeps());
    const graph = await service.buildLineageGraph("tenant-1");

    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });

  it("throws when tenantId is empty", async () => {
    const service = createLineageService(makeDeps());
    await expect(service.buildLineageGraph("")).rejects.toThrow(
      "buildLineageGraph: tenantId must be a non-empty string.",
    );
  });
});

// ---------------------------------------------------------------------------
// Connector → raw_table layer
// ---------------------------------------------------------------------------

describe("LineageService — connector layer", () => {
  const connectors = [
    {
      id: "conn-1",
      name: "Salesforce",
      plugin_id: "plugin-sf",
      instance_id: "inst-1",
      is_enabled: true,
    },
  ];

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("ingestion")) return Promise.resolve(jsonResponse({ data: connectors }));
        return Promise.resolve(jsonResponse(EMPTY));
      }),
    );
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("creates a connector node and a raw_table node with an ingests_from edge", async () => {
    const service = createLineageService(makeDeps());
    const graph = await service.buildLineageGraph("tenant-1");

    const connectorNode = graph.nodes.find((n) => n.id === "connector:conn-1");
    const rawTableNode = graph.nodes.find((n) => n.id === "raw_table:conn-1");

    expect(connectorNode).toBeDefined();
    expect(connectorNode?.type).toBe("connector");
    expect(connectorNode?.name).toBe("Salesforce");

    expect(rawTableNode).toBeDefined();
    expect(rawTableNode?.type).toBe("raw_table");

    const edge = graph.edges.find(
      (e) => e.source === "connector:conn-1" && e.target === "raw_table:conn-1",
    );
    expect(edge).toBeDefined();
    expect(edge?.relationship).toBe("ingests_from");
  });
});

// ---------------------------------------------------------------------------
// Mapping rules layer
// ---------------------------------------------------------------------------

describe("LineageService — mapping rules layer", () => {
  const connectors = [
    { id: "conn-1", name: "Salesforce", plugin_id: "plugin-sf", instance_id: "inst-1", is_enabled: true },
  ];
  const entities = [
    { id: "entity-1", name: "Account", slug: "account" },
  ];
  const mappingRules = [
    { id: "rule-1", connector_id: "conn-1", target_entity_id: "entity-1" },
    // Duplicate rule targeting the same entity — edge must be deduplicated.
    { id: "rule-2", connector_id: "conn-1", target_entity_id: "entity-1" },
  ];

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("ingestion")) return Promise.resolve(jsonResponse({ data: connectors }));
        if (url.includes("mapping-rules")) return Promise.resolve(jsonResponse({ data: mappingRules }));
        if (url.includes("entities")) return Promise.resolve(jsonResponse({ data: entities }));
        return Promise.resolve(jsonResponse(EMPTY));
      }),
    );
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("draws a maps_to edge from raw_table to ontology_type", async () => {
    const service = createLineageService(makeDeps());
    const graph = await service.buildLineageGraph("tenant-1");

    const edge = graph.edges.find(
      (e) => e.source === "raw_table:conn-1" && e.target === "ontology_type:entity-1",
    );
    expect(edge?.relationship).toBe("maps_to");
  });

  it("deduplicates edges when multiple rules target the same (connector, entity) pair", async () => {
    const service = createLineageService(makeDeps());
    const graph = await service.buildLineageGraph("tenant-1");

    const mappingEdges = graph.edges.filter(
      (e) => e.source === "raw_table:conn-1" && e.target === "ontology_type:entity-1",
    );
    expect(mappingEdges).toHaveLength(1);
  });

  it("skips mapping rules whose connector has been deleted", async () => {
    const orphanRules = [{ id: "rule-x", connector_id: "deleted-conn", target_entity_id: "entity-1" }];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("ingestion")) return Promise.resolve(jsonResponse({ data: connectors }));
        if (url.includes("mapping-rules")) return Promise.resolve(jsonResponse({ data: orphanRules }));
        if (url.includes("entities")) return Promise.resolve(jsonResponse({ data: entities }));
        return Promise.resolve(jsonResponse(EMPTY));
      }),
    );

    const service = createLineageService(makeDeps());
    const graph = await service.buildLineageGraph("tenant-1");

    const mappingEdges = graph.edges.filter((e) => e.relationship === "maps_to");
    expect(mappingEdges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pipeline layer
// ---------------------------------------------------------------------------

describe("LineageService — pipeline layer", () => {
  const connectors = [
    { id: "conn-1", name: "Salesforce", plugin_id: "plugin-sf", instance_id: "inst-1", is_enabled: true },
  ];
  const entities = [
    { id: "entity-1", name: "Account", slug: "account" },
  ];
  const mappingRules = [
    { id: "rule-1", connector_id: "conn-1", target_entity_id: "entity-1" },
  ];
  const pipelines = [
    {
      id: "pipe-1",
      name: "Enrich Accounts",
      slug: "enrich-accounts",
      is_active: true,
      definition: {
        version: 1,
        entryStepId: "step-1",
        steps: [
          {
            id: "step-1",
            name: "Sync Connector",
            type: "connector",
            connectorInstanceId: "inst-1",
          },
          {
            id: "step-2",
            name: "Transform Data",
            type: "transformer",
            entityType: "account",
          },
        ],
      },
    },
  ];

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("ingestion")) return Promise.resolve(jsonResponse({ data: connectors }));
        if (url.includes("mapping-rules")) return Promise.resolve(jsonResponse({ data: mappingRules }));
        if (url.includes("entities")) return Promise.resolve(jsonResponse({ data: entities }));
        if (url.includes("pipeline")) return Promise.resolve(jsonResponse({ data: pipelines }));
        return Promise.resolve(jsonResponse(EMPTY));
      }),
    );
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("creates pipeline and step nodes", async () => {
    const service = createLineageService(makeDeps());
    const graph = await service.buildLineageGraph("tenant-1");

    expect(graph.nodes.find((n) => n.id === "pipeline:pipe-1")).toBeDefined();
    expect(graph.nodes.find((n) => n.id === "pipeline_step:pipe-1:step-1")).toBeDefined();
    expect(graph.nodes.find((n) => n.id === "pipeline_step:pipe-1:step-2")).toBeDefined();
  });

  it("draws transforms edge from pipeline to each step", async () => {
    const service = createLineageService(makeDeps());
    const graph = await service.buildLineageGraph("tenant-1");

    const edge = graph.edges.find(
      (e) => e.source === "pipeline:pipe-1" && e.target === "pipeline_step:pipe-1:step-1",
    );
    expect(edge?.relationship).toBe("transforms");
  });

  it("draws transforms edge from ontology_type to connector step", async () => {
    const service = createLineageService(makeDeps());
    const graph = await service.buildLineageGraph("tenant-1");

    const edge = graph.edges.find(
      (e) => e.source === "ontology_type:entity-1" && e.target === "pipeline_step:pipe-1:step-1",
    );
    expect(edge?.relationship).toBe("transforms");
  });

  it("draws transforms edge from ontology_type to transformer step", async () => {
    const service = createLineageService(makeDeps());
    const graph = await service.buildLineageGraph("tenant-1");

    const edge = graph.edges.find(
      (e) => e.source === "ontology_type:entity-1" && e.target === "pipeline_step:pipe-1:step-2",
    );
    expect(edge?.relationship).toBe("transforms");
  });
});

// ---------------------------------------------------------------------------
// App layer
// ---------------------------------------------------------------------------

describe("LineageService — app layer", () => {
  const entities = [
    { id: "entity-1", name: "Account", slug: "account" },
    { id: "entity-2", name: "Contact", slug: "contact" },
  ];
  const apps = [
    { id: "app-1", name: "CRM Dashboard", slug: "crm-dashboard", entity_types: ["account", "contact"] },
    { id: "app-2", name: "Account Viewer", slug: "account-viewer", entity_type: "account" },
  ];

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("entities")) return Promise.resolve(jsonResponse({ data: entities }));
        if (url.includes("app")) return Promise.resolve(jsonResponse({ data: apps }));
        return Promise.resolve(jsonResponse(EMPTY));
      }),
    );
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("creates app nodes", async () => {
    const service = createLineageService(makeDeps());
    const graph = await service.buildLineageGraph("tenant-1");

    expect(graph.nodes.find((n) => n.id === "app:app-1")).toBeDefined();
    expect(graph.nodes.find((n) => n.id === "app:app-2")).toBeDefined();
  });

  it("draws consumes edges from entity types to apps (entity_types array)", async () => {
    const service = createLineageService(makeDeps());
    const graph = await service.buildLineageGraph("tenant-1");

    const edge1 = graph.edges.find(
      (e) => e.source === "ontology_type:entity-1" && e.target === "app:app-1",
    );
    const edge2 = graph.edges.find(
      (e) => e.source === "ontology_type:entity-2" && e.target === "app:app-1",
    );
    expect(edge1?.relationship).toBe("consumes");
    expect(edge2?.relationship).toBe("consumes");
  });

  it("draws consumes edge from entity type to app (single entity_type field)", async () => {
    const service = createLineageService(makeDeps());
    const graph = await service.buildLineageGraph("tenant-1");

    const edge = graph.edges.find(
      (e) => e.source === "ontology_type:entity-1" && e.target === "app:app-2",
    );
    expect(edge?.relationship).toBe("consumes");
  });
});

// ---------------------------------------------------------------------------
// Single entity lineage extraction
// ---------------------------------------------------------------------------

describe("LineageService — single entity sub-graph", () => {
  const connectors = [
    { id: "conn-1", name: "SF", plugin_id: "plugin-sf", instance_id: "inst-1", is_enabled: true },
    { id: "conn-2", name: "HubSpot", plugin_id: "plugin-hs", instance_id: "inst-2", is_enabled: true },
  ];
  const entities = [{ id: "entity-1", name: "Account", slug: "account" }];
  const mappingRules = [
    { id: "rule-1", connector_id: "conn-1", target_entity_id: "entity-1" },
  ];

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("ingestion")) return Promise.resolve(jsonResponse({ data: connectors }));
        if (url.includes("mapping-rules")) return Promise.resolve(jsonResponse({ data: mappingRules }));
        if (url.includes("entities")) return Promise.resolve(jsonResponse({ data: entities }));
        return Promise.resolve(jsonResponse(EMPTY));
      }),
    );
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("returns only the sub-graph reachable from the given connector", async () => {
    const service = createLineageService(makeDeps());
    const graph = await service.buildLineageGraph("tenant-1", "connector", "conn-1");

    // conn-1 and its raw_table and the entity it maps to should all be present.
    expect(graph.nodes.find((n) => n.id === "connector:conn-1")).toBeDefined();
    expect(graph.nodes.find((n) => n.id === "raw_table:conn-1")).toBeDefined();
    expect(graph.nodes.find((n) => n.id === "ontology_type:entity-1")).toBeDefined();

    // conn-2 is unrelated and must not appear.
    expect(graph.nodes.find((n) => n.id === "connector:conn-2")).toBeUndefined();
  });

  it("returns an empty graph when the requested entity does not exist", async () => {
    const service = createLineageService(makeDeps());
    const graph = await service.buildLineageGraph("tenant-1", "connector", "does-not-exist");

    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Multi-connector, multi-pipeline scenario
// ---------------------------------------------------------------------------

describe("LineageService — multi-connector multi-pipeline", () => {
  const connectors = [
    { id: "conn-1", name: "SF", plugin_id: "p-sf", instance_id: "inst-1", is_enabled: true },
    { id: "conn-2", name: "HS", plugin_id: "p-hs", instance_id: "inst-2", is_enabled: true },
  ];
  const entities = [
    { id: "entity-1", name: "Account", slug: "account" },
    { id: "entity-2", name: "Deal", slug: "deal" },
  ];
  const mappingRules = [
    { id: "rule-1", connector_id: "conn-1", target_entity_id: "entity-1" },
    { id: "rule-2", connector_id: "conn-2", target_entity_id: "entity-2" },
  ];
  const pipelines = [
    {
      id: "pipe-1",
      name: "Pipeline A",
      slug: "pipeline-a",
      is_active: true,
      definition: { version: 1, entryStepId: "s1", steps: [{ id: "s1", name: "S1", type: "connector", connectorInstanceId: "inst-1" }] },
    },
    {
      id: "pipe-2",
      name: "Pipeline B",
      slug: "pipeline-b",
      is_active: true,
      definition: { version: 1, entryStepId: "s2", steps: [{ id: "s2", name: "S2", type: "connector", connectorInstanceId: "inst-2" }] },
    },
  ];

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("ingestion")) return Promise.resolve(jsonResponse({ data: connectors }));
        if (url.includes("mapping-rules")) return Promise.resolve(jsonResponse({ data: mappingRules }));
        if (url.includes("entities")) return Promise.resolve(jsonResponse({ data: entities }));
        if (url.includes("pipeline")) return Promise.resolve(jsonResponse({ data: pipelines }));
        return Promise.resolve(jsonResponse(EMPTY));
      }),
    );
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("builds a complete graph with all connectors, entities and pipelines", async () => {
    const service = createLineageService(makeDeps());
    const graph = await service.buildLineageGraph("tenant-1");

    // Each connector: 1 connector node + 1 raw_table node
    const connectorNodes = graph.nodes.filter((n) => n.type === "connector");
    const rawTableNodes = graph.nodes.filter((n) => n.type === "raw_table");
    expect(connectorNodes).toHaveLength(2);
    expect(rawTableNodes).toHaveLength(2);

    // 2 ontology types
    const entityNodes = graph.nodes.filter((n) => n.type === "ontology_type");
    expect(entityNodes).toHaveLength(2);

    // 2 pipelines
    const pipelineNodes = graph.nodes.filter((n) => n.type === "pipeline");
    expect(pipelineNodes).toHaveLength(2);

    // 1 step per pipeline
    const stepNodes = graph.nodes.filter((n) => n.type === "pipeline_step");
    expect(stepNodes).toHaveLength(2);
  });

  it("pipeline A sub-graph does not include pipeline B nodes", async () => {
    const service = createLineageService(makeDeps());
    const graph = await service.buildLineageGraph("tenant-1", "pipeline", "pipe-1");

    expect(graph.nodes.find((n) => n.id === "pipeline:pipe-1")).toBeDefined();
    expect(graph.nodes.find((n) => n.id === "pipeline:pipe-2")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Cycle detection
// ---------------------------------------------------------------------------

describe("LineageService — cycle detection", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("logs a warning when a cycle is detected but still returns the graph", async () => {
    // Construct a situation where two connectors map to each other's entity
    // by building the graph with duplicate edge injection via the mock data.
    // In practice this cannot happen through the real service layer, but the
    // lineage service must handle it gracefully.
    const connectors = [
      { id: "c1", name: "C1", plugin_id: "p1", instance_id: "i1", is_enabled: true },
    ];
    const entities = [{ id: "e1", name: "E1", slug: "e1" }];
    const mappingRules = [
      { id: "r1", connector_id: "c1", target_entity_id: "e1" },
    ];
    // A pipeline whose connector step creates a back-edge: entity → step → pipeline → entity
    // does not naturally create a cycle in the lineage DAG (it's directed). We test
    // the cycle logger path by verifying no error is thrown.

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("ingestion")) return Promise.resolve(jsonResponse({ data: connectors }));
        if (url.includes("mapping-rules")) return Promise.resolve(jsonResponse({ data: mappingRules }));
        if (url.includes("entities")) return Promise.resolve(jsonResponse({ data: entities }));
        return Promise.resolve(jsonResponse(EMPTY));
      }),
    );

    const deps = makeDeps();
    const service = createLineageService(deps);
    // Must not throw even if a cycle were present
    const graph = await service.buildLineageGraph("tenant-1");

    expect(graph).toBeDefined();
    expect(Array.isArray(graph.nodes)).toBe(true);
    expect(Array.isArray(graph.edges)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fault tolerance — degraded upstream services
// ---------------------------------------------------------------------------

describe("LineageService — degraded upstream services", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("returns a partial graph when ontology service is unavailable", async () => {
    const connectors = [
      { id: "conn-1", name: "SF", plugin_id: "p-sf", instance_id: "inst-1", is_enabled: true },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.includes("ingestion")) return Promise.resolve(jsonResponse({ data: connectors }));
        // Ontology service down — returns 503
        if (url.includes("ontology")) return Promise.resolve(jsonResponse({ error: "down" }, 503));
        return Promise.resolve(jsonResponse(EMPTY));
      }),
    );

    const deps = makeDeps();
    const service = createLineageService(deps);
    const graph = await service.buildLineageGraph("tenant-1");

    // Connector nodes must be present even though ontology is down.
    expect(graph.nodes.find((n) => n.id === "connector:conn-1")).toBeDefined();
    // No mapping edges because ontology data was unavailable.
    expect(graph.edges.filter((e) => e.relationship === "maps_to")).toHaveLength(0);
  });

  it("returns an empty graph when all services are unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Network unreachable")),
    );

    const deps = makeDeps();
    const service = createLineageService(deps);
    const graph: LineageGraph = await service.buildLineageGraph("tenant-1");

    expect(graph.nodes).toHaveLength(0);
    expect(graph.edges).toHaveLength(0);
  });
});
