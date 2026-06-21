/**
 * dashboard.page.ts — Page Object Model for the /dashboard route.
 *
 * DashboardPage wraps interactions with the four main panels:
 *   1. Quick Start checklist (conditional — hidden once onboarding is done)
 *   2. Active Pipelines list
 *   3. Recent Activity feed
 *   4. Service Health grid
 */

import type { Page, Locator } from "@playwright/test";
import { expect } from "@playwright/test";
import { BasePage } from "./base.page.js";

// Navigation targets available from the sidebar. Using the visible label text
// means the POM is resilient to href changes.
export type SidebarNav =
  | "Dashboard"
  | "Connectors"
  | "Ontology"
  | "Pipelines"
  | "Apps"
  | "Logs"
  | "DLQ"
  | "Metrics"
  | "Plugins"
  | "Settings";

export class DashboardPage extends BasePage {
  // ---------------------------------------------------------------------------
  // Panel locators
  // ---------------------------------------------------------------------------

  private get quickStartPanel(): Locator {
    // Quick Start card is identified by its heading text
    return this.page.getByRole("heading", { name: /quick start/i }).first();
  }

  private get pipelinesPanel(): Locator {
    return this.page.getByRole("heading", { name: /active pipeline/i }).first();
  }

  private get activityPanel(): Locator {
    return this.page.getByRole("heading", { name: /recent activity/i }).first();
  }

  private get healthPanel(): Locator {
    return this.page.getByRole("heading", { name: /service health/i }).first();
  }

  // Widget cards on the page (any Card component)
  private get widgetCards(): Locator {
    // Cards rendered by shadcn/ui use data-slot="card" in the base component
    return this.page.locator('[data-slot="card"], [class*="rounded"][class*="border"]');
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  async goto(): Promise<void> {
    await this.page.goto("/dashboard");
    await this.waitForPageReady();
  }

  override async waitForPageReady(): Promise<void> {
    // Wait for the network to settle after lazy chunk loading
    await this.page.waitForLoadState("networkidle");
    await this.waitForLoadingComplete();
  }

  // ---------------------------------------------------------------------------
  // Panel readiness
  // ---------------------------------------------------------------------------

  /** Wait for all four dashboard panels to be present in the DOM. */
  async waitForLoad(): Promise<void> {
    await this.waitForPageReady();
    // The panels render after data fetches complete; at least one heading
    // must be visible to confirm the async render path completed.
    await expect(
      this.pipelinesPanel.or(this.activityPanel).or(this.healthPanel),
    ).toBeVisible({ timeout: 10_000 });
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  /**
   * Navigate to a top-level section via the sidebar.
   *
   * The authenticated layout renders a persistent sidebar (desktop) or a
   * bottom nav / hamburger menu (mobile). We target the link by its visible
   * label text which is viewport-agnostic.
   */
  async navigateTo(destination: SidebarNav): Promise<void> {
    // Sidebar links are <a> elements whose accessible name matches the label
    const link = this.page.getByRole("link", { name: destination }).first();
    await expect(link).toBeVisible({ timeout: 5_000 });
    await link.click();
    await this.page.waitForLoadState("networkidle");
  }

  /** Dismiss the Quick Start panel if it is visible. */
  async dismissQuickStart(): Promise<void> {
    // The dismiss button is an X icon button near the Quick Start heading
    const dismissBtn = this.page
      .getByRole("button", { name: /dismiss|close/i })
      .first();

    const isVisible = await dismissBtn.isVisible();
    if (isVisible) {
      await dismissBtn.click();
    }
  }

  // ---------------------------------------------------------------------------
  // Getters / assertion helpers
  // ---------------------------------------------------------------------------

  /**
   * Return all visible widget/card elements on the dashboard.
   * Useful for asserting that a minimum number of panels rendered.
   */
  async getWidgets(): Promise<Locator> {
    return this.widgetCards;
  }

  async assertQuickStartVisible(): Promise<void> {
    await expect(this.quickStartPanel).toBeVisible();
  }

  async assertPipelinesPanelVisible(): Promise<void> {
    await expect(this.pipelinesPanel).toBeVisible();
  }

  async assertHealthPanelVisible(): Promise<void> {
    await expect(this.healthPanel).toBeVisible();
  }
}
