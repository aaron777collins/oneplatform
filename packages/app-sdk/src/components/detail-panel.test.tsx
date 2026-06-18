/**
 * Tests for DetailPanel component.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import * as React from "react";
import { DetailPanel } from "./detail-panel.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderPanel(props: Partial<React.ComponentProps<typeof DetailPanel>> = {}) {
  return render(
    <DetailPanel
      open={true}
      onClose={vi.fn()}
      title="User Details"
      {...props}
    >
      <p>Panel content</p>
    </DetailPanel>,
  );
}

describe("DetailPanel", () => {
  // Restore body overflow after each test to avoid cross-test contamination.
  afterEach(() => {
    document.body.style.overflow = "";
  });

  describe("visibility", () => {
    it("renders nothing when open is false", () => {
      const { container } = render(
        <DetailPanel open={false} onClose={vi.fn()} title="Hidden">
          <p>content</p>
        </DetailPanel>,
      );
      expect(container.firstChild).toBeNull();
    });

    it("renders the panel when open is true", () => {
      renderPanel();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });

  describe("title and description", () => {
    it("renders the panel title", () => {
      renderPanel({ title: "Order #1234" });
      expect(screen.getByText("Order #1234")).toBeInTheDocument();
    });

    it("renders description when provided", () => {
      renderPanel({ description: "Created on Jan 1 2024" });
      expect(screen.getByText("Created on Jan 1 2024")).toBeInTheDocument();
    });

    it("does not render description element when omitted", () => {
      // renderPanel() defaults render with no description — omit the prop entirely
      // rather than passing undefined (exactOptionalPropertyTypes forbids `prop: undefined`).
      renderPanel();
      expect(screen.queryByText("Created on Jan 1 2024")).not.toBeInTheDocument();
    });
  });

  describe("children", () => {
    it("renders panel children", () => {
      renderPanel();
      expect(screen.getByText("Panel content")).toBeInTheDocument();
    });

    it("renders nothing in body when children is undefined", () => {
      render(<DetailPanel open={true} onClose={vi.fn()} title="Empty" />);
      // Panel should still open and show the header
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });
  });

  describe("close button", () => {
    it("renders a close button", () => {
      renderPanel();
      expect(screen.getByRole("button", { name: "Close panel" })).toBeInTheDocument();
    });

    it("calls onClose when close button is clicked", () => {
      const onClose = vi.fn();
      renderPanel({ onClose });
      fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  describe("backdrop", () => {
    it("calls onClose when backdrop is clicked", () => {
      const onClose = vi.fn();
      renderPanel({ onClose });
      // The backdrop is the first div child of the fixed container
      const backdrop = document.querySelector(".absolute.inset-0") as HTMLElement;
      fireEvent.click(backdrop);
      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  describe("keyboard interaction", () => {
    it("calls onClose when Escape key is pressed", () => {
      const onClose = vi.fn();
      renderPanel({ onClose });
      fireEvent.keyDown(document, { key: "Escape" });
      expect(onClose).toHaveBeenCalledOnce();
    });

    it("does not call onClose for other key presses", () => {
      const onClose = vi.fn();
      renderPanel({ onClose });
      fireEvent.keyDown(document, { key: "Enter" });
      expect(onClose).not.toHaveBeenCalled();
    });

    it("removes the keydown listener when closed", () => {
      const onClose = vi.fn();
      const { rerender } = render(
        <DetailPanel open={true} onClose={onClose} title="Panel">
          <p>content</p>
        </DetailPanel>,
      );
      // Close the panel by re-rendering with open=false
      rerender(
        <DetailPanel open={false} onClose={onClose} title="Panel">
          <p>content</p>
        </DetailPanel>,
      );
      fireEvent.keyDown(document, { key: "Escape" });
      // Should not have been called because the listener was cleaned up
      expect(onClose).not.toHaveBeenCalled();
    });
  });

  describe("body scroll lock", () => {
    it("sets overflow hidden on document.body when open", () => {
      renderPanel();
      expect(document.body.style.overflow).toBe("hidden");
    });

    it("restores body overflow when panel closes", () => {
      const { rerender } = render(
        <DetailPanel open={true} onClose={vi.fn()} title="Panel">
          <p>content</p>
        </DetailPanel>,
      );
      expect(document.body.style.overflow).toBe("hidden");
      rerender(
        <DetailPanel open={false} onClose={vi.fn()} title="Panel">
          <p>content</p>
        </DetailPanel>,
      );
      expect(document.body.style.overflow).toBe("");
    });

    it("restores body overflow on unmount", () => {
      const { unmount } = renderPanel();
      unmount();
      expect(document.body.style.overflow).toBe("");
    });
  });

  describe("accessibility", () => {
    it("panel has role=dialog", () => {
      renderPanel();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("panel has aria-modal=true", () => {
      renderPanel();
      expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
    });

    it("panel is labelled by the title element", () => {
      renderPanel({ title: "Invoice #99" });
      // The dialog's aria-labelledby should point to an element containing the title
      const dialog = screen.getByRole("dialog");
      const labelledById = dialog.getAttribute("aria-labelledby");
      expect(labelledById).toBeTruthy();
      const labelEl = document.getElementById(labelledById!);
      expect(labelEl).toHaveTextContent("Invoice #99");
    });
  });

  describe("focus management", () => {
    it("moves focus to the panel when it opens", async () => {
      renderPanel();
      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByRole("dialog"));
      });
    });
  });

  describe("custom width", () => {
    it("applies custom width class to the panel", () => {
      renderPanel({ width: "w-96" });
      const dialog = screen.getByRole("dialog");
      expect(dialog.className).toMatch(/w-96/);
    });
  });
});
