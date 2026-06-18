/**
 * Tests for StatCard component.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import * as React from "react";
import { StatCard } from "./stat-card.js";

describe("StatCard", () => {
  describe("basic rendering", () => {
    it("renders title and numeric value", () => {
      render(<StatCard title="Total Users" value={1234} />);
      expect(screen.getByText("Total Users")).toBeInTheDocument();
      // toLocaleString may produce "1,234" or "1234" depending on locale
      expect(screen.getByText(/1.?234/)).toBeInTheDocument();
    });

    it("renders a string value without modification", () => {
      render(<StatCard title="Status" value="Healthy" />);
      expect(screen.getByText("Healthy")).toBeInTheDocument();
    });

    it("formats numeric values with toLocaleString", () => {
      render(<StatCard title="Revenue" value={1000000} />);
      // Must contain 1 and 0s with optional separators — exact format is locale-dependent
      expect(screen.getByText(/1[,.]?000[,.]?000|1000000/)).toBeInTheDocument();
    });
  });

  describe("trend indicator", () => {
    it("shows upward arrow and positive percentage for positive change", () => {
      render(<StatCard title="Growth" value={500} change={12.5} />);
      expect(screen.getByText(/▲/)).toBeInTheDocument();
      expect(screen.getByText(/12\.5%/)).toBeInTheDocument();
    });

    it("shows downward arrow for negative change", () => {
      render(<StatCard title="Churn" value={20} change={-3.2} />);
      expect(screen.getByText(/▼/)).toBeInTheDocument();
      expect(screen.getByText(/3\.2%/)).toBeInTheDocument();
    });

    it("hides trend indicator when change is exactly zero", () => {
      render(<StatCard title="Flat" value={100} change={0} />);
      expect(screen.queryByText(/▲/)).not.toBeInTheDocument();
      expect(screen.queryByText(/▼/)).not.toBeInTheDocument();
    });

    it("does not render trend indicator when change is omitted", () => {
      render(<StatCard title="Count" value={99} />);
      expect(screen.queryByText(/▲/)).not.toBeInTheDocument();
    });

    it("aria-label on trend includes direction and value", () => {
      render(<StatCard title="Growth" value={500} change={12.5} />);
      expect(screen.getByLabelText(/Up 12\.5% from previous period/i)).toBeInTheDocument();
    });
  });

  describe("icon", () => {
    it("renders icon when provided", () => {
      const MockIcon = ({ className }: { className?: string }) => (
        <svg data-testid="mock-icon" className={className} />
      );
      render(<StatCard title="Users" value={10} icon={MockIcon} />);
      expect(screen.getByTestId("mock-icon")).toBeInTheDocument();
    });

    it("does not render icon container when icon is omitted", () => {
      const { container } = render(<StatCard title="Users" value={10} />);
      // No icon element present
      expect(container.querySelector("svg")).not.toBeInTheDocument();
    });
  });

  describe("variants", () => {
    it("renders without throwing for each variant", () => {
      for (const variant of ["default", "success", "warning", "danger"] as const) {
        const { unmount } = render(
          <StatCard title="Metric" value={1} variant={variant} />,
        );
        expect(screen.getByText("Metric")).toBeInTheDocument();
        unmount();
      }
    });
  });

  describe("optional props", () => {
    it("renders correctly with only required props", () => {
      render(<StatCard title="Minimal" value="N/A" />);
      expect(screen.getByText("Minimal")).toBeInTheDocument();
      expect(screen.getByText("N/A")).toBeInTheDocument();
    });

    it("applies className to the card wrapper", () => {
      const { container } = render(
        <StatCard title="Styled" value={1} className="test-class" />,
      );
      expect(container.firstChild).toHaveClass("test-class");
    });
  });
});
