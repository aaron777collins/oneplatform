/**
 * test-data.ts — Canonical test data used across all E2E specs.
 *
 * Centralizing test data here ensures every spec that references "the admin
 * user" or "the customer pipeline" uses identical values, which matters for
 * assertions on mock API responses (which are keyed to these same values).
 */

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const TEST_USERS = {
  admin: {
    email: "e2e-tester@oneplatform.test",
    password: "Test@Password123!",
    name: "E2E Tester",
    role: "tenant-admin" as const,
  },
  viewer: {
    email: "viewer@oneplatform.test",
    password: "Viewer@Password123!",
    name: "Viewer User",
    role: "viewer" as const,
  },
} as const;

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

export const TEST_PIPELINES = {
  active: {
    id: "pipe-001",
    name: "Customer Events Pipeline",
  },
  failed: {
    id: "pipe-002",
    name: "Product Catalog Sync",
  },
  running: {
    id: "pipe-003",
    name: "Order Processing",
  },
} as const;

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

export const TEST_CONNECTORS = {
  postgres: {
    id: "conn-001",
    name: "Postgres Production",
    type: "postgres",
  },
  kafka: {
    id: "conn-002",
    name: "Kafka Cluster",
    type: "kafka",
  },
} as const;

// ---------------------------------------------------------------------------
// Entity types
// ---------------------------------------------------------------------------

export const TEST_ENTITY_TYPES = {
  customer: {
    id: "et-001",
    name: "Customer",
  },
  order: {
    id: "et-002",
    name: "Order",
  },
} as const;

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

export const TEST_APPS = {
  published: {
    id: "app-001",
    name: "Customer 360 Dashboard",
  },
  draft: {
    id: "app-002",
    name: "Order Operations Portal",
  },
} as const;

// ---------------------------------------------------------------------------
// Pipeline builder node configs (used by pipeline-editor.page.ts tests)
// ---------------------------------------------------------------------------

export interface PipelineNodeConfig {
  type: string;
  label: string;
  position: { x: number; y: number };
}

export const TEST_PIPELINE_NODES: PipelineNodeConfig[] = [
  { type: "source", label: "Kafka Source", position: { x: 100, y: 200 } },
  { type: "transform", label: "Enrich Events", position: { x: 400, y: 200 } },
  { type: "sink", label: "Postgres Sink", position: { x: 700, y: 200 } },
];

// ---------------------------------------------------------------------------
// App builder component configs
// ---------------------------------------------------------------------------

export interface AppComponentConfig {
  type: string;
  label: string;
}

export const TEST_APP_COMPONENTS: AppComponentConfig[] = [
  { type: "table", label: "Data Table" },
  { type: "chart", label: "Line Chart" },
  { type: "form", label: "Input Form" },
];

// ---------------------------------------------------------------------------
// Viewport labels — must match the project names in playwright.config.ts
// ---------------------------------------------------------------------------

export const VIEWPORT_LABELS = ["desktop", "tablet", "mobile"] as const;
export type ViewportLabel = (typeof VIEWPORT_LABELS)[number];
