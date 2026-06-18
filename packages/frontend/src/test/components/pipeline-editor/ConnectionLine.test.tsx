/**
 * Tests for ConnectionLine component
 *
 * SVG rendering tests focus on the structural output (path element, label)
 * rather than pixel-exact coordinates, since jsdom doesn't do layout.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { ConnectionLine } from "@/components/pipeline-editor/ConnectionLine.js";

function renderLine(overrides: Partial<React.ComponentProps<typeof ConnectionLine>> = {}) {
  const defaults: React.ComponentProps<typeof ConnectionLine> = {
    id: "edge-1",
    sourceX: 100,
    sourceY: 50,
    targetX: 300,
    targetY: 50,
    ...overrides,
  };
  return render(
    <svg>
      <ConnectionLine {...defaults} />
    </svg>
  );
}

describe("ConnectionLine", () => {
  it("renders a path element", () => {
    const { container } = renderLine();
    const paths = container.querySelectorAll("path");
    expect(paths.length).toBeGreaterThanOrEqual(1);
  });

  it("renders a label text when label prop is provided", () => {
    renderLine({ label: "then" });
    expect(screen.getByText("then")).toBeInTheDocument();
  });

  it("does not render label text when label is undefined", () => {
    renderLine();
    expect(screen.queryByText("then")).not.toBeInTheDocument();
    expect(screen.queryByText("else")).not.toBeInTheDocument();
  });

  it("renders with accessible role and aria-label", () => {
    renderLine({ label: "then" });
    expect(screen.getByRole("button", { name: /pipeline connection.*then/i })).toBeInTheDocument();
  });

  it("calls onClick with the edge id when clicked", async () => {
    const onClick = vi.fn();
    renderLine({ onClick });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledWith("edge-1");
  });

  it("does not throw when onClick is undefined", async () => {
    renderLine({ onClick: undefined });
    const user = userEvent.setup();
    // Should not throw
    await user.click(screen.getByRole("button"));
  });

  it("renders dashed path when isDragging is true", () => {
    const { container } = renderLine({ isDragging: true });
    const paths = Array.from(container.querySelectorAll("path"));
    const dashedPath = paths.find((p) => p.getAttribute("stroke-dasharray") !== null);
    expect(dashedPath).toBeDefined();
  });
});
