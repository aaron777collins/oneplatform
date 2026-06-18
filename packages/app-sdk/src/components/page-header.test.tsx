/**
 * Tests for PageHeader component.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import * as React from "react";
import { PageHeader } from "./page-header.js";
import type { ActionItem, BreadcrumbItem } from "./page-header.js";

describe("PageHeader", () => {
  describe("title and description", () => {
    it("renders the page title as an h1", () => {
      render(<PageHeader title="Dashboard" />);
      expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    });

    it("renders description when provided", () => {
      render(<PageHeader title="Dashboard" description="Overview of key metrics." />);
      expect(screen.getByText("Overview of key metrics.")).toBeInTheDocument();
    });

    it("does not render description element when omitted", () => {
      render(<PageHeader title="Dashboard" />);
      // Check no secondary text element renders
      expect(screen.queryByText(/Overview/)).not.toBeInTheDocument();
    });
  });

  describe("breadcrumbs", () => {
    const crumbs: BreadcrumbItem[] = [
      { label: "Home", href: "/" },
      { label: "Settings", href: "/settings" },
      { label: "Profile" },
    ];

    it("renders a breadcrumb nav landmark", () => {
      render(<PageHeader title="Profile" breadcrumbs={crumbs} />);
      expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeInTheDocument();
    });

    it("renders all breadcrumb labels", () => {
      render(<PageHeader title="Profile" breadcrumbs={crumbs} />);
      expect(screen.getByText("Home")).toBeInTheDocument();
      expect(screen.getByText("Settings")).toBeInTheDocument();
      // "Profile" appears both as the last breadcrumb span AND as the h1.
      // getAllByText ensures both exist; the nav must contain at least one.
      const profileMatches = screen.getAllByText("Profile");
      expect(profileMatches.length).toBeGreaterThanOrEqual(2);
    });

    it("renders intermediate crumbs as <a> links", () => {
      render(<PageHeader title="Profile" breadcrumbs={crumbs} />);
      const homeLink = screen.getByRole("link", { name: "Home" });
      expect(homeLink).toHaveAttribute("href", "/");
    });

    it("renders last crumb without a link", () => {
      render(<PageHeader title="Profile" breadcrumbs={crumbs} />);
      // The last crumb renders as a <span aria-current="page"> inside the nav.
      // We locate it via the nav landmark to disambiguate from the h1 title.
      const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
      // The crumb span sits inside the nav; find the one with aria-current
      const lastCrumbSpan = nav.querySelector('[aria-current="page"]') as HTMLElement;
      expect(lastCrumbSpan).not.toBeNull();
      expect(lastCrumbSpan.tagName.toLowerCase()).toBe("span");
      expect(lastCrumbSpan).toHaveTextContent("Profile");
    });

    it("does not render breadcrumb nav when breadcrumbs is empty", () => {
      render(<PageHeader title="Page" breadcrumbs={[]} />);
      expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    });

    it("does not render breadcrumb nav when breadcrumbs is omitted", () => {
      render(<PageHeader title="Page" />);
      expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    });

    it("calls onClick on breadcrumb link when clicked", () => {
      const onClick = vi.fn((e: React.MouseEvent<HTMLAnchorElement>) => e.preventDefault());
      const crumbsWithClick: BreadcrumbItem[] = [
        { label: "Home", href: "/", onClick },
        { label: "Current" },
      ];
      render(<PageHeader title="Current" breadcrumbs={crumbsWithClick} />);
      fireEvent.click(screen.getByRole("link", { name: "Home" }));
      expect(onClick).toHaveBeenCalledOnce();
    });
  });

  describe("action buttons", () => {
    const actions: ActionItem[] = [
      { label: "Save", onClick: vi.fn(), variant: "primary" },
      { label: "Cancel", onClick: vi.fn(), variant: "outline" },
    ];

    it("renders action buttons", () => {
      render(<PageHeader title="Edit" actions={actions} />);
      expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    });

    it("calls the action's onClick handler when button is clicked", () => {
      const save = vi.fn();
      render(<PageHeader title="Edit" actions={[{ label: "Save", onClick: save }]} />);
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(save).toHaveBeenCalledOnce();
    });

    it("renders disabled button when disabled is true", () => {
      render(
        <PageHeader
          title="Edit"
          actions={[{ label: "Submit", onClick: vi.fn(), disabled: true }]}
        />,
      );
      expect(screen.getByRole("button", { name: "Submit" })).toBeDisabled();
    });

    it("does not render action container when actions is empty", () => {
      render(<PageHeader title="Page" actions={[]} />);
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("does not render action container when actions is omitted", () => {
      render(<PageHeader title="Page" />);
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("applies destructive variant styling", () => {
      render(
        <PageHeader
          title="Page"
          actions={[{ label: "Delete", onClick: vi.fn(), variant: "destructive" }]}
        />,
      );
      const btn = screen.getByRole("button", { name: "Delete" });
      expect(btn.className).toMatch(/red/);
    });
  });

  describe("optional props", () => {
    it("applies className to the header element", () => {
      const { container } = render(<PageHeader title="Page" className="custom-header" />);
      expect(container.firstChild).toHaveClass("custom-header");
    });
  });

  describe("full composition", () => {
    it("renders title, description, breadcrumbs, and actions together", () => {
      const crumbs: BreadcrumbItem[] = [{ label: "Apps", href: "/apps" }, { label: "Edit" }];
      const actions: ActionItem[] = [{ label: "Publish", onClick: vi.fn() }];
      render(
        <PageHeader
          title="Edit App"
          description="Modify the application configuration."
          breadcrumbs={crumbs}
          actions={actions}
        />,
      );
      expect(screen.getByRole("heading", { name: "Edit App" })).toBeInTheDocument();
      expect(screen.getByText("Modify the application configuration.")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Apps" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Publish" })).toBeInTheDocument();
    });
  });
});
