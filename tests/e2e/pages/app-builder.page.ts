/**
 * app-builder.page.ts — Page Object Model for /apps/$id/build.
 *
 * The App Builder (AppBuilderPage.tsx) renders a drag-and-drop UI component
 * canvas. This POM abstracts the canvas interactions so specs remain readable
 * regardless of the underlying component library the builder uses.
 */

import type { Page, Locator } from "@playwright/test";
import { expect } from "@playwright/test";
import { BasePage } from "./base.page.js";
import type { AppComponentConfig } from "../helpers/test-data.js";

export class AppBuilderPage extends BasePage {
  private readonly appId: string;

  constructor(page: Page, appId: string) {
    super(page);
    this.appId = appId;
  }

  // ---------------------------------------------------------------------------
  // Locators
  // ---------------------------------------------------------------------------

  private get builderCanvas(): Locator {
    return this.page
      .locator(
        '[data-testid="app-canvas"], [data-testid="builder-canvas"], [role="application"]',
      )
      .first();
  }

  private get componentPalette(): Locator {
    return this.page
      .locator('[data-testid="component-palette"], aside, [aria-label*="component"]')
      .first();
  }

  private get saveButton(): Locator {
    return this.page.getByRole("button", { name: /save|publish/i }).first();
  }

  private get previewButton(): Locator {
    return this.page.getByRole("button", { name: /preview/i }).first();
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  async goto(): Promise<void> {
    await this.page.goto(`/apps/${this.appId}/build`);
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
   * Add a UI component to the builder canvas.
   *
   * Tries to find the component type by its label text in the palette and
   * drag it to the center of the canvas. If dragging is not possible (e.g.
   * the element has no bounding box), falls back to clicking.
   */
  async addComponent(config: AppComponentConfig): Promise<void> {
    // Locate the component in the palette by its label
    const paletteItem = this.page
      .getByText(config.label, { exact: false })
      .or(this.page.getByRole("button", { name: new RegExp(config.label, "i") }))
      .first();

    const paletteBox = await paletteItem.boundingBox().catch(() => null);
    const canvasBox = await this.builderCanvas.boundingBox().catch(() => null);

    if (paletteBox && canvasBox) {
      // Drag from palette item center to canvas center
      const fromX = paletteBox.x + paletteBox.width / 2;
      const fromY = paletteBox.y + paletteBox.height / 2;
      const toX = canvasBox.x + canvasBox.width / 2;
      const toY = canvasBox.y + canvasBox.height / 2;

      await this.page.mouse.move(fromX, fromY);
      await this.page.mouse.down();
      await this.page.mouse.move(toX, toY, { steps: 15 });
      await this.page.mouse.up();
    } else if (await paletteItem.isVisible().catch(() => false)) {
      // Fallback: just click the palette item
      await paletteItem.click();
    }
  }

  /**
   * Configure a component on the canvas.
   *
   * Clicks the component (selecting it), then interacts with the properties
   * panel that appears. The `properties` map keys are property label texts
   * and values are the new values to set.
   */
  async configureComponent(
    componentLabel: string,
    properties: Record<string, string>,
  ): Promise<void> {
    // Select the component by clicking on it
    const component = this.page
      .getByText(componentLabel, { exact: false })
      .first();

    if (await component.isVisible().catch(() => false)) {
      await component.click();
    }

    // Set each property in the properties panel
    for (const [propLabel, value] of Object.entries(properties)) {
      const propInput = this.page
        .getByLabel(new RegExp(propLabel, "i"))
        .or(this.page.locator(`input[placeholder*="${propLabel}" i]`))
        .first();

      if (await propInput.isVisible().catch(() => false)) {
        await propInput.fill(value);
      }
    }
  }

  /** Save the current app state. */
  async save(): Promise<void> {
    await expect(this.saveButton).toBeEnabled({ timeout: 5_000 });
    await this.saveButton.click();
    await this.page.waitForLoadState("networkidle");
  }

  /** Open the preview mode for the app. */
  async openPreview(): Promise<void> {
    await expect(this.previewButton).toBeVisible({ timeout: 5_000 });
    await this.previewButton.click();
    await this.page.waitForLoadState("networkidle");
  }

  // ---------------------------------------------------------------------------
  // Assertions
  // ---------------------------------------------------------------------------

  async assertBuilderLoaded(): Promise<void> {
    // Builder is loaded when either the canvas or the save button is visible
    await expect(
      this.saveButton.or(this.builderCanvas),
    ).toBeVisible({ timeout: 10_000 });
  }

  async assertComponentOnCanvas(label: string): Promise<void> {
    await expect(
      this.page.getByText(label, { exact: false }).first(),
    ).toBeVisible();
  }
}
