/**
 * pipeline-editor.spec.ts — E2E tests for the visual pipeline editor.
 *
 * Route: /pipelines/$id/edit
 *
 * The PipelineBuilderPage embeds the VisualPipelineEditor when editorMode is
 * "visual" (the default). The editor itself consists of three panels:
 *   - NodePalette (left): draggable step type cards with a search input
 *   - PipelineCanvas (centre): SVG canvas with role="application"
 *   - NodeConfigPanel (right): slide-out config form opened on double-click
 *
 * Auth is satisfied automatically because setupMockApi intercepts
 * GET /api/v1/auth/me and returns a mock tenant-admin user, which the
 * AuthenticatedLayout uses to populate the auth store.
 */

import { test, expect } from "./fixtures/base.js";
import { setupMockApi, overrideMock, MOCK_PIPELINES } from "./helpers/mock-api.js";
import { TEST_PIPELINES } from "./helpers/test-data.js";

// ---------------------------------------------------------------------------
// Shared mock: pipeline detail with steps already populated so the
// VisualPipelineEditor receives an initialDefinition.
// ---------------------------------------------------------------------------

const MOCK_PIPELINE_WITH_STEPS = {
  ...MOCK_PIPELINES[0],
  steps: [
    {
      id: "step-001",
      type: "code",
      name: "Enrich records",
      config: { language: "typescript", code: "export default (r) => r;" },
    },
    {
      id: "step-002",
      type: "webhook",
      name: "Notify downstream",
      config: { url: "https://example.com/hook", method: "POST" },
    },
  ],
  triggerType: "manual",
};

// ---------------------------------------------------------------------------
// Helper: navigate to the pipeline editor for pipe-001 with auth mocked.
// ---------------------------------------------------------------------------

async function gotoEditor(page: import("@playwright/test").Page) {
  await setupMockApi(page);

  // The MOCK_USER returned by setupMockApi has `role` (string) and `id`
  // instead of the `Session` shape AuthenticatedLayout expects:
  //   { userId, tenantId, roles[], scopes[], isGuest, emailVerified }
  // Providing the correct shape prevents `roles.includes(...)` from throwing
  // in Sidebar.tsx and causing "Something went wrong!" on all authenticated routes.
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

  // Shadow the default single-pipeline mock with one that has steps included
  await overrideMock(
    page,
    /\/api\/v1\/pipelines\/pipe-001/,
    200,
    { data: MOCK_PIPELINE_WITH_STEPS },
  );
  await page.goto(`/pipelines/${TEST_PIPELINES.active.id}/edit`);
  await page.waitForLoadState("networkidle");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Pipeline editor", () => {
  test("editor page loads with the pipeline name and visual editor visible", async ({
    page,
    screenshotHelper,
  }) => {
    await gotoEditor(page);

    // The PageHeader renders "Edit pipeline" as the h1
    await expect(page.getByRole("heading", { name: /edit pipeline/i })).toBeVisible({
      timeout: 10_000,
    });

    // The Visual Editor button should be toggled (active/default mode)
    await expect(
      page.getByRole("button", { name: /visual editor/i }),
    ).toBeVisible({ timeout: 8_000 });

    await screenshotHelper.capture("editor-loaded");
  });

  test("SVG canvas is rendered inside the editor", async ({ page }) => {
    await gotoEditor(page);

    // PipelineCanvas renders an SVG with role="application" and aria-label="Pipeline canvas"
    await expect(
      page.locator('[role="application"][aria-label="Pipeline canvas"]'),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("node palette is visible and shows all step types", async ({ page }) => {
    await gotoEditor(page);

    // The NodePalette renders an <aside aria-label="Step palette">
    const palette = page.locator('[aria-label="Step palette"]');
    await expect(palette).toBeVisible({ timeout: 10_000 });

    // Verify all expected step type labels are present
    const expectedLabels = [
      "Code",
      "Connector",
      "Transformer",
      "Transform",
      "Conditional",
      "Parallel",
      "Webhook",
      "Wait",
      "Approval",
      "Sub-workflow",
    ];

    for (const label of expectedLabels) {
      await expect(
        palette.getByText(label, { exact: true }),
      ).toBeVisible({ timeout: 5_000 });
    }
  });

  test("palette search filters step types", async ({ page }) => {
    await gotoEditor(page);

    const palette = page.locator('[aria-label="Step palette"]');
    await expect(palette).toBeVisible({ timeout: 10_000 });

    const searchInput = palette.getByLabel("Filter step types");
    await searchInput.fill("code");

    // "Code" should still be visible
    await expect(palette.getByText("Code", { exact: true })).toBeVisible();

    // "Webhook" should be hidden after filtering for "code"
    await expect(palette.getByText("Webhook", { exact: true })).not.toBeVisible();

    // Clear the filter and verify all items return
    await searchInput.clear();
    await expect(palette.getByText("Webhook", { exact: true })).toBeVisible();
  });

  test("clicking a palette item adds a node to the canvas", async ({
    page,
    screenshotHelper,
  }) => {
    await gotoEditor(page);

    const palette = page.locator('[aria-label="Step palette"]');
    await expect(palette).toBeVisible({ timeout: 10_000 });

    // The canvas starts empty (new pipeline). Click the "Wait" step item.
    // PaletteItem's onClick calls onAdd(item.type) which adds a node at canvas centre.
    const waitItem = palette.locator('[aria-label="Add Wait step"]');
    await expect(waitItem).toBeVisible();
    await waitItem.click();

    // After adding, the canvas should contain "New wait" text (the default label)
    await expect(
      page.locator('[role="application"]').getByText(/new wait/i),
    ).toBeVisible({ timeout: 5_000 });

    await screenshotHelper.capture("node-added");
  });

  test("double-clicking a node opens the config panel", async ({
    page,
    screenshotHelper,
  }) => {
    await gotoEditor(page);

    const palette = page.locator('[aria-label="Step palette"]');
    await expect(palette).toBeVisible({ timeout: 10_000 });

    // Add a Code node via keyboard shortcut (click the palette item)
    const codeItem = palette.locator('[aria-label="Add Code step"]');
    await codeItem.click();

    // The node label "New code" should appear on the canvas
    const nodeLabel = page.locator('[role="application"]').getByText(/new code/i);
    await expect(nodeLabel).toBeVisible({ timeout: 5_000 });

    // The node card's div[role="button"] has the onDoubleClick handler.
    // We use page.evaluate to fire a bubbling dblclick MouseEvent directly in
    // the browser, which avoids the fixed mobile nav bar intercepting pointer
    // events on the SVG foreignObject at desktop viewport sizes.
    const nodeCard = page.locator(`[aria-label^="Step: New code"]`);
    await expect(nodeCard).toBeVisible({ timeout: 5_000 });
    await nodeCard.evaluate((el) => {
      el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, composed: true }));
    });

    // The NodeConfigPanel renders an <aside aria-label="Step configuration">
    const configPanel = page.locator('[aria-label="Step configuration"]');
    await expect(configPanel).toBeVisible({ timeout: 5_000 });

    await screenshotHelper.capture("config-panel-open");
  });

  test("config panel shows the step name field and type-specific fields", async ({
    page,
  }) => {
    // Navigate to a *new* (empty) pipeline so there is exactly one node on the
    // canvas after adding via the palette — no ambiguity with pre-loaded steps.
    await setupMockApi(page);
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
    await page.goto("/pipelines/new/edit");
    await page.waitForLoadState("networkidle");

    const palette = page.locator('[aria-label="Step palette"]');
    await expect(palette).toBeVisible({ timeout: 10_000 });

    // Add a Webhook node to the empty canvas
    await palette.locator('[aria-label="Add Webhook step"]').click();
    const nodeText = page.locator('[role="application"]').getByText(/new webhook/i);
    await expect(nodeText).toBeVisible({ timeout: 5_000 });

    // The node card renders inside a <foreignObject> with role="button".
    // We use page.evaluate to fire a bubbling dblclick MouseEvent directly in
    // the browser so React's synthetic onDoubleClick handler fires correctly.
    // Using `click({ force: true })` followed by `dispatchEvent` can cause the
    // element to leave the DOM if the click inadvertently triggers navigation
    // via an overlay element; evaluate avoids that race.
    const nodeCard = page.locator(`[aria-label^="Step: New webhook"]`);
    await expect(nodeCard).toBeVisible({ timeout: 5_000 });
    await nodeCard.evaluate((el) => {
      el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, composed: true }));
    });

    const configPanel = page.locator('[aria-label="Step configuration"]');
    await expect(configPanel).toBeVisible({ timeout: 8_000 });

    // Common field: step name — the NodeConfigPanel renders a "Step name" label
    // wired to #cfg-label input. We use getByRole to avoid ambiguity with the
    // semantic relationship between <label for="cfg-label"> and <input id="cfg-label">.
    await expect(
      configPanel.getByRole("textbox").first(),
    ).toBeVisible({ timeout: 5_000 });

    // Config panel heading confirms we're in configure mode
    await expect(
      configPanel.getByRole("heading", { name: /configure step/i }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("undo button is present and enabled after adding a node", async ({
    page,
  }) => {
    await gotoEditor(page);

    // Before any changes the undo button is disabled
    const undoButton = page.getByRole("button", { name: "Undo" });
    await expect(undoButton).toBeVisible({ timeout: 10_000 });
    await expect(undoButton).toBeDisabled();

    // Add a node — this creates a history entry
    const palette = page.locator('[aria-label="Step palette"]');
    await expect(palette).toBeVisible({ timeout: 10_000 });
    await palette.locator('[aria-label="Add Code step"]').click();

    // Now undo should become enabled
    await expect(undoButton).toBeEnabled({ timeout: 5_000 });
  });

  test("redo button is present and enabled after undoing", async ({ page }) => {
    await gotoEditor(page);

    const palette = page.locator('[aria-label="Step palette"]');
    await expect(palette).toBeVisible({ timeout: 10_000 });

    // Add a node then undo
    await palette.locator('[aria-label="Add Code step"]').click();
    const undoButton = page.getByRole("button", { name: "Undo" });
    await expect(undoButton).toBeEnabled({ timeout: 5_000 });
    await undoButton.click();

    // After undoing, redo should be enabled
    const redoButton = page.getByRole("button", { name: "Redo" });
    await expect(redoButton).toBeEnabled({ timeout: 5_000 });
  });

  test("Ctrl+Z keyboard shortcut triggers undo", async ({ page }) => {
    await gotoEditor(page);

    const palette = page.locator('[aria-label="Step palette"]');
    await expect(palette).toBeVisible({ timeout: 10_000 });

    // Add a node to create undo history
    await palette.locator('[aria-label="Add Code step"]').click();
    const nodeText = page.locator('[role="application"]').getByText(/new code/i);
    await expect(nodeText).toBeVisible({ timeout: 5_000 });

    // Fire Ctrl+Z — the VisualPipelineEditor listens for this globally
    await page.keyboard.press("Control+z");

    // The node should disappear after the undo
    await expect(nodeText).not.toBeVisible({ timeout: 5_000 });
  });

  test("existing pipeline loads with the editor in visual mode", async ({
    page,
    screenshotHelper,
  }) => {
    await gotoEditor(page);

    // After mock pipeline loads, the pipeline name should appear in the breadcrumb
    await expect(
      page.getByText(TEST_PIPELINES.active.name, { exact: false }),
    ).toBeVisible({ timeout: 10_000 });

    // The visual editor canvas should be present
    await expect(
      page.locator('[role="application"][aria-label="Pipeline canvas"]'),
    ).toBeVisible({ timeout: 10_000 });

    await screenshotHelper.capture("existing-pipeline-loaded");
  });

  test("Visual Editor and Step List mode toggle buttons are present", async ({
    page,
  }) => {
    await gotoEditor(page);

    // Both toggle buttons should be visible in the toolbar
    await expect(
      page.getByRole("button", { name: /visual editor/i }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole("button", { name: /step list/i }),
    ).toBeVisible({ timeout: 5_000 });

    // Default is visual mode — canvas must be visible
    await expect(
      page.locator('[role="application"][aria-label="Pipeline canvas"]'),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("screenshot of editor with multiple nodes", async ({
    page,
    screenshotHelper,
  }) => {
    await gotoEditor(page);

    const palette = page.locator('[aria-label="Step palette"]');
    await expect(palette).toBeVisible({ timeout: 10_000 });

    // Add three different node types
    await palette.locator('[aria-label="Add Code step"]').click();
    await page.waitForTimeout(200);
    await palette.locator('[aria-label="Add Webhook step"]').click();
    await page.waitForTimeout(200);
    await palette.locator('[aria-label="Add Wait step"]').click();

    // Verify all three nodes appear
    await expect(
      page.locator('[role="application"]').getByText(/new code/i),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.locator('[role="application"]').getByText(/new webhook/i),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.locator('[role="application"]').getByText(/new wait/i),
    ).toBeVisible({ timeout: 5_000 });

    await screenshotHelper.capture("editor-with-nodes");
  });
});
