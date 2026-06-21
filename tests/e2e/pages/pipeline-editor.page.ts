/**
 * pipeline-editor.page.ts — Page Object Model for /pipelines/$id/edit.
 *
 * The Pipeline Builder (PipelineBuilderPage.tsx) renders a visual drag-and-drop
 * editor. This POM provides high-level actions that abstract away the canvas
 * coordinates and drag mechanics, keeping specs readable.
 *
 * Implementation note: the visual editor is a canvas-based UI. Playwright's
 * mouse API (mouse.move, mouse.down, mouse.up) drives drag-and-drop since
 * React synthetic drag events fire on the underlying DOM elements.
 */

import type { Page, Locator } from "@playwright/test";
import { expect } from "@playwright/test";
import { BasePage } from "./base.page.js";
import type { PipelineNodeConfig } from "../helpers/test-data.js";

export class PipelineEditorPage extends BasePage {
  private readonly pipelineId: string;

  constructor(page: Page, pipelineId: string) {
    super(page);
    this.pipelineId = pipelineId;
  }

  // ---------------------------------------------------------------------------
  // Locators
  // ---------------------------------------------------------------------------

  private get editorCanvas(): Locator {
    // The pipeline builder wraps its canvas in a container with a known
    // role or data attribute. Fall back to the main content area if not present.
    return (
      this.page.locator('[data-testid="pipeline-canvas"], [role="application"]').first()
      || this.page.locator("main").first()
    );
  }

  private get saveButton(): Locator {
    return this.page.getByRole("button", { name: /save/i }).first();
  }

  private get addNodePanel(): Locator {
    // Node palette / sidebar where users drag from
    return this.page.locator(
      '[data-testid="node-palette"], [aria-label*="node"], aside',
    ).first();
  }

  private get pageTitle(): Locator {
    return this.page.locator("h1, [data-testid='pipeline-title']").first();
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  async goto(): Promise<void> {
    await this.page.goto(`/pipelines/${this.pipelineId}/edit`);
    await this.waitForPageReady();
  }

  override async waitForPageReady(): Promise<void> {
    await this.page.waitForLoadState("networkidle");
    await this.waitForLoadingComplete();
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /**
   * Add a node to the pipeline canvas.
   *
   * For canvas-based editors, "adding a node" may mean:
   *   a) Clicking a node type in the palette, or
   *   b) Dragging from the palette to the canvas.
   *
   * This implementation clicks the palette item by type label, which works
   * when the editor supports click-to-add. The coordinates in the config
   * are used when drag-drop is required.
   */
  async addNode(config: PipelineNodeConfig): Promise<void> {
    // Try to find the node type button in the palette by its label
    const paletteItem = this.page
      .getByRole("button", { name: new RegExp(config.label, "i") })
      .or(this.page.getByText(config.label, { exact: false }))
      .first();

    const isVisible = await paletteItem.isVisible().catch(() => false);

    if (isVisible) {
      await paletteItem.click();
    } else {
      // Fallback: click the canvas at the target position, which some editors
      // interpret as "place the currently selected node type here"
      const canvasBox = await this.editorCanvas.boundingBox();
      if (canvasBox) {
        await this.page.mouse.click(
          canvasBox.x + config.position.x,
          canvasBox.y + config.position.y,
        );
      }
    }
  }

  /**
   * Connect two nodes by their labels.
   *
   * Dragging from the output port of `fromLabel` to the input port of
   * `toLabel` is the standard connection gesture in flow editors. This
   * implementation uses coordinate-based drag since port elements are
   * typically small and may not have accessible labels.
   *
   * For now this is a best-effort implementation; adjust port offsets
   * once the actual editor DOM structure is known.
   */
  async connectNodes(fromLabel: string, toLabel: string): Promise<void> {
    const fromNode = this.page
      .getByText(fromLabel, { exact: false })
      .first();
    const toNode = this.page.getByText(toLabel, { exact: false }).first();

    const fromBox = await fromNode.boundingBox();
    const toBox = await toNode.boundingBox();

    if (!fromBox || !toBox) {
      throw new Error(
        `Cannot connect nodes: "${fromLabel}" or "${toLabel}" not found in viewport`,
      );
    }

    // Drag from the right edge (output port) of the source node to the
    // left edge (input port) of the target node
    const fromX = fromBox.x + fromBox.width;
    const fromY = fromBox.y + fromBox.height / 2;
    const toX = toBox.x;
    const toY = toBox.y + toBox.height / 2;

    await this.page.mouse.move(fromX, fromY);
    await this.page.mouse.down();
    await this.page.mouse.move(toX, toY, { steps: 10 });
    await this.page.mouse.up();
  }

  /** Click the Save button and wait for the save to complete. */
  async save(): Promise<void> {
    await expect(this.saveButton).toBeEnabled({ timeout: 5_000 });
    await this.saveButton.click();
    // Wait for a toast or the button to return to its non-loading state
    await this.page.waitForLoadState("networkidle");
  }

  // ---------------------------------------------------------------------------
  // Assertions
  // ---------------------------------------------------------------------------

  async assertEditorLoaded(): Promise<void> {
    // The editor is "loaded" when the canvas container is in the DOM and
    // the save button is available (implying the pipeline data has been fetched)
    await expect(this.saveButton).toBeVisible({ timeout: 10_000 });
  }

  async assertNodeVisible(label: string): Promise<void> {
    await expect(
      this.page.getByText(label, { exact: false }).first(),
    ).toBeVisible();
  }
}
