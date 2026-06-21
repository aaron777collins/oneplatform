/**
 * query-builder.spec.ts — E2E tests for the visual query builder.
 *
 * Route: /ontology/query
 *
 * The QueryBuilderPage:
 *   1. Fetches GET /api/v1/ontology — returns entity type list (needs `slug`)
 *   2. On entity type selection fetches GET /api/v1/ontology/:slug — entity detail
 *   3. On "Run query" POSTs to /api/v1/ontology/query — query results
 *
 * The default mock table covers /api/v1/ontology/entity-types but NOT
 * /api/v1/ontology. We use overrideMock to fill those gaps.
 *
 * Auth is satisfied by setupMockApi intercepting GET /api/v1/auth/me.
 */

import { test, expect } from "./fixtures/base.js";
import { setupMockApi, overrideMock } from "./helpers/mock-api.js";

// ---------------------------------------------------------------------------
// Mock entity data for the query builder
// ---------------------------------------------------------------------------

// The QueryBuilderPage reads EntitySummary.slug to build dropdown options.
// Standard mock entity types lack the slug field, so we define richer mocks here.
const MOCK_ENTITY_LIST = [
  {
    id: "et-001",
    name: "Customer",
    slug: "customer",
    description: "A customer entity",
    fieldCount: 5,
    relationshipCount: 2,
    updatedAt: "2025-01-05T00:00:00.000Z",
  },
  {
    id: "et-002",
    name: "Order",
    slug: "order",
    description: "An order placed by a customer",
    fieldCount: 8,
    relationshipCount: 3,
    updatedAt: "2025-01-06T00:00:00.000Z",
  },
];

const MOCK_ENTITY_DETAIL = {
  id: "et-001",
  name: "Customer",
  slug: "customer",
  fields: [
    { slug: "name", name: "Name", fieldType: "string" },
    { slug: "email", name: "Email", fieldType: "string" },
    { slug: "status", name: "Status", fieldType: "string" },
    { slug: "revenue", name: "Revenue", fieldType: "number" },
    { slug: "created_at", name: "Created At", fieldType: "datetime" },
  ],
};

const MOCK_QUERY_RESULT = {
  columns: [
    { name: "name", type: "string" },
    { name: "email", type: "string" },
    { name: "status", type: "string" },
    { name: "revenue", type: "number" },
  ],
  rows: [
    { name: "Alice Johnson", email: "alice@example.com", status: "active", revenue: 12500 },
    { name: "Bob Smith", email: "bob@example.com", status: "inactive", revenue: 3200 },
    { name: "Carol Williams", email: "carol@example.com", status: "active", revenue: 27800 },
  ],
  totalCount: 3,
  executionTimeMs: 42,
};

// ---------------------------------------------------------------------------
// Helper: set up all mocks and navigate to the query builder.
// ---------------------------------------------------------------------------

async function gotoQueryBuilder(page: import("@playwright/test").Page) {
  await setupMockApi(page);

  // Override auth/me with a properly-shaped Session (roles as array, userId not id).
  // The default MOCK_USER shape causes roles.includes() to throw in Sidebar.tsx.
  await overrideMock(page, /\/api\/v1\/auth\/me/, 200, {
    data: {
      userId: "user-e2e-001",
      tenantId: "tenant-e2e-001",
      roles: ["tenant-admin"],
      scopes: ["*"],
      isGuest: false,
      emailVerified: true,
      email: "e2e-tester@oneplatform.test",
      displayName: "E2E Tester",
      tenantName: "E2E Tenant",
    },
  });

  // The QueryBuilderPage calls GET /v1/ontology (not /v1/ontology/entity-types).
  // We must register this AFTER setupMockApi so our handler wins (LIFO order).
  await overrideMock(page, /\/api\/v1\/ontology$/, 200, {
    data: MOCK_ENTITY_LIST,
    pagination: { total: MOCK_ENTITY_LIST.length, nextCursor: null },
  });

  // Entity detail endpoint: GET /api/v1/ontology/:slug
  await overrideMock(page, /\/api\/v1\/ontology\/customer/, 200, {
    data: MOCK_ENTITY_DETAIL,
  });
  await overrideMock(page, /\/api\/v1\/ontology\/order/, 200, {
    data: { ...MOCK_ENTITY_DETAIL, id: "et-002", name: "Order", slug: "order" },
  });

  // Query execution: POST /api/v1/ontology/query
  await overrideMock(page, /\/api\/v1\/ontology\/query/, 200, {
    data: MOCK_QUERY_RESULT,
  });

  await page.goto("/ontology/query");
  await page.waitForLoadState("networkidle");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Query builder", () => {
  test("query builder page loads with the Query Builder heading", async ({
    page,
    screenshotHelper,
  }) => {
    await gotoQueryBuilder(page);

    await expect(
      page.getByRole("heading", { name: /query builder/i }),
    ).toBeVisible({ timeout: 10_000 });

    await screenshotHelper.capture("query-builder-loaded");
  });

  test("entity type dropdown is present and shows entity options", async ({
    page,
  }) => {
    await gotoQueryBuilder(page);

    // The entity type section heading
    await expect(
      page.getByRole("heading", { name: /entity type/i }),
    ).toBeVisible({ timeout: 10_000 });

    // The SelectTrigger for entity type
    const entityTrigger = page.getByRole("combobox", { name: "Entity type" });
    await expect(entityTrigger).toBeVisible({ timeout: 8_000 });

    // Open the dropdown
    await entityTrigger.click();

    // Mock entities should appear in the dropdown
    await expect(
      page.getByRole("option", { name: "Customer" }),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.getByRole("option", { name: "Order" }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("selecting an entity type shows the fields section", async ({ page }) => {
    await gotoQueryBuilder(page);

    const entityTrigger = page.getByRole("combobox", { name: "Entity type" });
    await expect(entityTrigger).toBeVisible({ timeout: 10_000 });
    await entityTrigger.click();
    await page.getByRole("option", { name: "Customer" }).click();

    // After selection the "Columns to select" section should appear
    await expect(
      page.getByRole("heading", { name: /columns to select/i }),
    ).toBeVisible({ timeout: 8_000 });

    // Mock fields should appear as checkboxes / pill buttons.
    // Scope to the Fields group to avoid ambiguity with the SQL preview block
    // which may also contain SQL keywords like field names.
    const fieldsGroup = page.getByRole("group", { name: "Fields" });
    await expect(fieldsGroup.getByText("Name")).toBeVisible({ timeout: 5_000 });
    await expect(fieldsGroup.getByText("Email")).toBeVisible({ timeout: 5_000 });
    await expect(fieldsGroup.getByText("Status")).toBeVisible({ timeout: 5_000 });
  });

  test("adding a WHERE filter condition shows the clause row", async ({
    page,
    screenshotHelper,
  }) => {
    await gotoQueryBuilder(page);

    // Select entity type first
    const entityTrigger = page.getByRole("combobox", { name: "Entity type" });
    await expect(entityTrigger).toBeVisible({ timeout: 10_000 });
    await entityTrigger.click();
    await page.getByRole("option", { name: "Customer" }).click();

    // Wait for fields to load
    await expect(
      page.getByRole("heading", { name: /columns to select/i }),
    ).toBeVisible({ timeout: 8_000 });

    // Click "Add filter"
    const addFilterBtn = page.getByRole("button", { name: /add filter/i });
    await expect(addFilterBtn).toBeVisible({ timeout: 5_000 });
    await addFilterBtn.click();

    // A WhereClauseRow should appear with a Field selector, Operator selector, and Value input.
    // Use getByRole("combobox") to avoid strict mode violations from the "Fields" group
    // whose aria-label="Fields" is a superset of "Field".
    await expect(page.getByRole("combobox", { name: "Field" })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("combobox", { name: "Operator" })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByRole("textbox", { name: "Value" })).toBeVisible({ timeout: 5_000 });

    await screenshotHelper.capture("where-filter-added");
  });

  test("adding an ORDER BY rule shows the order row", async ({ page }) => {
    await gotoQueryBuilder(page);

    const entityTrigger = page.getByRole("combobox", { name: "Entity type" });
    await expect(entityTrigger).toBeVisible({ timeout: 10_000 });
    await entityTrigger.click();
    await page.getByRole("option", { name: "Customer" }).click();

    await expect(
      page.getByRole("heading", { name: /columns to select/i }),
    ).toBeVisible({ timeout: 8_000 });

    // Click "Add sort"
    const addSortBtn = page.getByRole("button", { name: /add sort/i });
    await expect(addSortBtn).toBeVisible({ timeout: 5_000 });
    await addSortBtn.click();

    // An OrderByRow should appear with field and direction selectors
    await expect(page.getByLabel("Order by field")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByLabel("Direction")).toBeVisible({ timeout: 5_000 });
  });

  test("adding a GROUP BY field shows the group row", async ({ page }) => {
    await gotoQueryBuilder(page);

    const entityTrigger = page.getByRole("combobox", { name: "Entity type" });
    await expect(entityTrigger).toBeVisible({ timeout: 10_000 });
    await entityTrigger.click();
    await page.getByRole("option", { name: "Customer" }).click();

    await expect(
      page.getByRole("heading", { name: /columns to select/i }),
    ).toBeVisible({ timeout: 8_000 });

    // Click "Add group"
    const addGroupBtn = page.getByRole("button", { name: /add group/i });
    await expect(addGroupBtn).toBeVisible({ timeout: 5_000 });
    await addGroupBtn.click();

    // A GroupByRow should appear with a field selector
    await expect(page.getByLabel("Group by field")).toBeVisible({ timeout: 5_000 });
  });

  test("Run query button is visible and clickable when an entity type is selected", async ({
    page,
  }) => {
    await gotoQueryBuilder(page);

    // Select entity type
    const entityTrigger = page.getByRole("combobox", { name: "Entity type" });
    await expect(entityTrigger).toBeVisible({ timeout: 10_000 });
    await entityTrigger.click();
    await page.getByRole("option", { name: "Customer" }).click();

    await expect(
      page.getByRole("heading", { name: /columns to select/i }),
    ).toBeVisible({ timeout: 8_000 });

    // The "Run query" button appears after entity selection
    const runBtn = page.getByRole("button", { name: /run query/i });
    await expect(runBtn).toBeVisible({ timeout: 5_000 });
    await expect(runBtn).toBeEnabled();
  });

  test("running a query shows results and the Table/Chart/SQL tabs", async ({
    page,
    screenshotHelper,
  }) => {
    await gotoQueryBuilder(page);

    // Select entity type
    const entityTrigger = page.getByRole("combobox", { name: "Entity type" });
    await expect(entityTrigger).toBeVisible({ timeout: 10_000 });
    await entityTrigger.click();
    await page.getByRole("option", { name: "Customer" }).click();

    await expect(
      page.getByRole("heading", { name: /columns to select/i }),
    ).toBeVisible({ timeout: 8_000 });

    // Click Run query
    await page.getByRole("button", { name: /run query/i }).click();

    // The results tablist should appear: Table | Chart | SQL
    const tablist = page.getByRole("tablist", { name: "Result view" });
    await expect(tablist).toBeVisible({ timeout: 10_000 });

    await expect(tablist.getByRole("tab", { name: "Table" })).toBeVisible();
    await expect(tablist.getByRole("tab", { name: /chart/i })).toBeVisible();
    await expect(tablist.getByRole("tab", { name: /sql/i })).toBeVisible();

    await screenshotHelper.capture("query-results");
  });

  test("query results show the data rows from the mock", async ({ page }) => {
    await gotoQueryBuilder(page);

    const entityTrigger = page.getByRole("combobox", { name: "Entity type" });
    await expect(entityTrigger).toBeVisible({ timeout: 10_000 });
    await entityTrigger.click();
    await page.getByRole("option", { name: "Customer" }).click();

    await expect(
      page.getByRole("heading", { name: /columns to select/i }),
    ).toBeVisible({ timeout: 8_000 });

    await page.getByRole("button", { name: /run query/i }).click();

    // The table tab is selected by default. The mock rows should be visible.
    await expect(page.getByText("Alice Johnson")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("Bob Smith")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Carol Williams")).toBeVisible({ timeout: 5_000 });
  });

  test("switching to Chart tab shows the chart visualisation", async ({
    page,
    screenshotHelper,
  }) => {
    await gotoQueryBuilder(page);

    const entityTrigger = page.getByRole("combobox", { name: "Entity type" });
    await expect(entityTrigger).toBeVisible({ timeout: 10_000 });
    await entityTrigger.click();
    await page.getByRole("option", { name: "Customer" }).click();

    await expect(
      page.getByRole("heading", { name: /columns to select/i }),
    ).toBeVisible({ timeout: 8_000 });

    await page.getByRole("button", { name: /run query/i }).click();

    // Switch to Chart tab
    const tablist = page.getByRole("tablist", { name: "Result view" });
    await expect(tablist).toBeVisible({ timeout: 10_000 });
    await tablist.getByRole("tab", { name: /chart/i }).click();

    // Chart type controls should appear
    await expect(page.getByRole("group", { name: "Chart type" })).toBeVisible({
      timeout: 5_000,
    });

    await screenshotHelper.capture("chart-tab");
  });

  test("switching to SQL tab shows the SQL preview", async ({
    page,
    screenshotHelper,
  }) => {
    await gotoQueryBuilder(page);

    const entityTrigger = page.getByRole("combobox", { name: "Entity type" });
    await expect(entityTrigger).toBeVisible({ timeout: 10_000 });
    await entityTrigger.click();
    await page.getByRole("option", { name: "Customer" }).click();

    await expect(
      page.getByRole("heading", { name: /columns to select/i }),
    ).toBeVisible({ timeout: 8_000 });

    await page.getByRole("button", { name: /run query/i }).click();

    // Switch to SQL tab
    const tablist = page.getByRole("tablist", { name: "Result view" });
    await expect(tablist).toBeVisible({ timeout: 10_000 });
    await tablist.getByRole("tab", { name: /sql/i }).click();

    // The SQL preview block has aria-label="SQL preview"
    await expect(page.getByLabel("SQL preview")).toBeVisible({ timeout: 5_000 });

    await screenshotHelper.capture("sql-tab");
  });

  test("CSV export button appears after running a query", async ({ page }) => {
    await gotoQueryBuilder(page);

    const entityTrigger = page.getByRole("combobox", { name: "Entity type" });
    await expect(entityTrigger).toBeVisible({ timeout: 10_000 });
    await entityTrigger.click();
    await page.getByRole("option", { name: "Customer" }).click();

    await expect(
      page.getByRole("heading", { name: /columns to select/i }),
    ).toBeVisible({ timeout: 8_000 });

    await page.getByRole("button", { name: /run query/i }).click();

    // After query completes the Export CSV button should appear
    await expect(
      page.getByRole("button", { name: /export csv/i }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("Saved queries panel appears when the Saved queries button is clicked", async ({
    page,
    screenshotHelper,
  }) => {
    await gotoQueryBuilder(page);

    await expect(
      page.getByRole("heading", { name: /query builder/i }),
    ).toBeVisible({ timeout: 10_000 });

    // The "Saved queries" button is in the PageHeader actions area
    const savedQueriesBtn = page.getByRole("button", { name: /saved queries/i });
    await expect(savedQueriesBtn).toBeVisible({ timeout: 5_000 });
    await savedQueriesBtn.click();

    // The SavedQueriesPanel section should appear
    await expect(
      page.getByRole("heading", { name: /saved queries/i }),
    ).toBeVisible({ timeout: 5_000 });

    // The name input for saving a new query should be visible
    await expect(
      page.getByLabel("Saved query name"),
    ).toBeVisible({ timeout: 5_000 });

    await screenshotHelper.capture("saved-queries-panel");
  });

  test("saving a query stores it and shows it in the list", async ({ page }) => {
    await gotoQueryBuilder(page);

    await expect(
      page.getByRole("heading", { name: /query builder/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Open saved queries panel
    await page.getByRole("button", { name: /saved queries/i }).click();
    await expect(page.getByLabel("Saved query name")).toBeVisible({ timeout: 5_000 });

    // Type a name and save
    await page.getByLabel("Saved query name").fill("My E2E Query");
    await page.getByRole("button", { name: /^save$/i }).click();

    // The saved query should appear in the list
    await expect(
      page.getByText("My E2E Query", { exact: true }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("query preview (SQL) is visible before running the query", async ({
    page,
  }) => {
    await gotoQueryBuilder(page);

    const entityTrigger = page.getByRole("combobox", { name: "Entity type" });
    await expect(entityTrigger).toBeVisible({ timeout: 10_000 });
    await entityTrigger.click();
    await page.getByRole("option", { name: "Customer" }).click();

    await expect(
      page.getByRole("heading", { name: /columns to select/i }),
    ).toBeVisible({ timeout: 8_000 });

    // Before running, a "Query preview" section shows the SQL
    await expect(
      page.getByRole("heading", { name: /query preview/i }),
    ).toBeVisible({ timeout: 5_000 });

    await expect(
      page.getByLabel("SQL preview"),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("screenshot of full query builder with results", async ({
    page,
    screenshotHelper,
  }) => {
    await gotoQueryBuilder(page);

    const entityTrigger = page.getByRole("combobox", { name: "Entity type" });
    await expect(entityTrigger).toBeVisible({ timeout: 10_000 });
    await entityTrigger.click();
    await page.getByRole("option", { name: "Customer" }).click();

    await expect(
      page.getByRole("heading", { name: /columns to select/i }),
    ).toBeVisible({ timeout: 8_000 });

    // Add a where filter for completeness
    await page.getByRole("button", { name: /add filter/i }).click();

    // Run the query
    await page.getByRole("button", { name: /run query/i }).click();

    await expect(page.getByText("Alice Johnson")).toBeVisible({ timeout: 10_000 });

    await screenshotHelper.capture("full-query-with-results");
  });
});
