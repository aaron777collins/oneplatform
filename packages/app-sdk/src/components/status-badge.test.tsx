/**
 * Tests for StatusBadge component.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import * as React from "react";
import { StatusBadge } from "./status-badge.js";
import type { PredefinedStatus } from "./status-badge.js";

describe("StatusBadge", () => {
  describe("predefined statuses", () => {
    const cases: PredefinedStatus[] = ["active", "inactive", "error", "warning", "pending"];

    for (const status of cases) {
      it(`renders correctly for status "${status}"`, () => {
        render(<StatusBadge status={status} />);
        const badge = screen.getByRole("status");
        expect(badge).toBeInTheDocument();
        // Label is capitalised version of status
        const expectedLabel = status.charAt(0).toUpperCase() + status.slice(1);
        expect(badge).toHaveTextContent(expectedLabel);
        expect(badge).toHaveAttribute("aria-label", `Status: ${expectedLabel}`);
      });
    }
  });

  describe("custom status strings", () => {
    it("renders unknown status string with gray fallback", () => {
      render(<StatusBadge status="archived" />);
      const badge = screen.getByRole("status");
      expect(badge).toHaveTextContent("Archived");
      // Gray variant class should be applied — check classes contain muted token
      expect(badge.className).toMatch(/muted/);
    });

    it("capitalises custom status label", () => {
      render(<StatusBadge status="processing" />);
      expect(screen.getByRole("status")).toHaveTextContent("Processing");
    });
  });

  describe("color override", () => {
    it("uses explicit color prop over the predefined map", () => {
      // "active" maps to green by default; override to blue
      render(<StatusBadge status="active" color="blue" />);
      const badge = screen.getByRole("status");
      expect(badge.className).toMatch(/blue/);
    });

    it("applies each supported color", () => {
      // Each color maps to a distinct set of Tailwind classes. We verify a
      // representative token per color rather than asserting the word "gray"
      // since the gray variant uses CSS variable tokens (--color-muted).
      const colorTokens: Record<string, RegExp> = {
        green: /green/,
        gray: /muted/,    // gray uses --color-muted CSS variable tokens
        red: /red/,
        yellow: /yellow/,
        blue: /blue/,
      };
      for (const [color, pattern] of Object.entries(colorTokens)) {
        const { unmount } = render(
          <StatusBadge status="test" color={color as "green" | "gray" | "red" | "yellow" | "blue"} />,
        );
        const badge = screen.getByRole("status");
        expect(badge.className).toMatch(pattern);
        unmount();
      }
    });
  });

  describe("accessibility", () => {
    it("has role=status", () => {
      render(<StatusBadge status="active" />);
      expect(screen.getByRole("status")).toBeInTheDocument();
    });

    it("has descriptive aria-label", () => {
      render(<StatusBadge status="error" />);
      expect(screen.getByLabelText("Status: Error")).toBeInTheDocument();
    });
  });

  describe("optional props", () => {
    it("applies className to the badge element", () => {
      render(<StatusBadge status="active" className="extra-class" />);
      expect(screen.getByRole("status")).toHaveClass("extra-class");
    });
  });
});
