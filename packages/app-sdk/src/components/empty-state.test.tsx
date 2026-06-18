/**
 * Tests for EmptyState component.
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import * as React from "react";
import { EmptyState } from "./empty-state.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MockIcon = ({ className }: { className?: string }) => (
  <svg data-testid="empty-icon" className={className} />
);

describe("EmptyState", () => {
  describe("basic rendering", () => {
    it("renders title", () => {
      render(<EmptyState title="No results found" />);
      expect(screen.getByText("No results found")).toBeInTheDocument();
    });

    it("renders description when provided", () => {
      render(<EmptyState title="Empty" description="Try adjusting your filters." />);
      expect(screen.getByText("Try adjusting your filters.")).toBeInTheDocument();
    });

    it("does not render description element when omitted", () => {
      render(<EmptyState title="Empty" />);
      // Only the title paragraph should be present
      expect(screen.queryByText("Try adjusting your filters.")).not.toBeInTheDocument();
    });
  });

  describe("icon", () => {
    it("renders icon when provided", () => {
      render(<EmptyState title="Empty" icon={MockIcon} />);
      expect(screen.getByTestId("empty-icon")).toBeInTheDocument();
    });

    it("does not render icon wrapper when icon is omitted", () => {
      const { container } = render(<EmptyState title="Empty" />);
      expect(container.querySelector("svg")).not.toBeInTheDocument();
    });
  });

  describe("action button", () => {
    it("renders primary CTA button when action is provided", () => {
      render(
        <EmptyState
          title="Empty"
          action={{ label: "Add item", onClick: vi.fn() }}
        />,
      );
      expect(screen.getByRole("button", { name: "Add item" })).toBeInTheDocument();
    });

    it("does not render button when action is omitted", () => {
      render(<EmptyState title="Empty" />);
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
    });

    it("calls onClick when CTA button is clicked", () => {
      const onClick = vi.fn();
      render(
        <EmptyState
          title="Empty"
          action={{ label: "Create", onClick }}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      expect(onClick).toHaveBeenCalledOnce();
    });

    it("renders outline variant button", () => {
      render(
        <EmptyState
          title="Empty"
          action={{ label: "Learn more", onClick: vi.fn(), variant: "outline" }}
        />,
      );
      const btn = screen.getByRole("button", { name: "Learn more" });
      expect(btn.className).toMatch(/border/);
    });

    it("renders primary variant button (default)", () => {
      render(
        <EmptyState
          title="Empty"
          action={{ label: "Get started", onClick: vi.fn() }}
        />,
      );
      const btn = screen.getByRole("button", { name: "Get started" });
      // Primary variant should reference the primary color token
      expect(btn.className).toMatch(/primary/);
    });
  });

  describe("layout and styling", () => {
    it("applies custom className to the wrapper", () => {
      const { container } = render(
        <EmptyState title="Empty" className="custom-empty" />,
      );
      expect(container.firstChild).toHaveClass("custom-empty");
    });
  });

  describe("full composition", () => {
    it("renders all props together without error", () => {
      render(
        <EmptyState
          icon={MockIcon}
          title="No data available"
          description="Start by creating your first record."
          action={{ label: "Create record", onClick: vi.fn() }}
        />,
      );
      expect(screen.getByTestId("empty-icon")).toBeInTheDocument();
      expect(screen.getByText("No data available")).toBeInTheDocument();
      expect(screen.getByText("Start by creating your first record.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Create record" })).toBeInTheDocument();
    });
  });
});
