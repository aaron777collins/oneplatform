/**
 * ConfirmDialog tests
 *
 * Radix UI Dialog renders its content into a portal (document.body), so we
 * query with screen.queryByRole("dialog") rather than within the render container.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React, { useState } from "react";
import { ConfirmDialog } from "@/components/shared/ConfirmDialog.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Props {
  open?: boolean;
  title?: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm?: () => void;
  onOpenChange?: (open: boolean) => void;
  isLoading?: boolean;
}

function renderDialog(overrides: Props = {}) {
  const defaults = {
    open: true,
    title: "Delete item",
    description: "This action cannot be undone.",
    onConfirm: vi.fn(),
    onOpenChange: vi.fn(),
  };
  const props = { ...defaults, ...overrides };
  return { ...render(<ConfirmDialog {...props} />), props };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ConfirmDialog", () => {
  const user = userEvent.setup();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("open=false", () => {
    it("does not render dialog content when open is false", () => {
      renderDialog({ open: false });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  describe("open=true", () => {
    it("renders the dialog", () => {
      renderDialog();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("renders the title text", () => {
      renderDialog({ title: "Confirm removal" });
      expect(screen.getByText("Confirm removal")).toBeInTheDocument();
    });

    it("renders the description text", () => {
      renderDialog({ description: "You are about to delete this record." });
      expect(screen.getByText("You are about to delete this record.")).toBeInTheDocument();
    });
  });

  describe("cancel button", () => {
    it("calls onOpenChange(false) when cancel is clicked", async () => {
      const onOpenChange = vi.fn();
      renderDialog({ onOpenChange });

      await user.click(screen.getByRole("button", { name: /cancel/i }));

      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it("renders the default cancel label 'Cancel'", () => {
      renderDialog();
      expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    });

    it("renders a custom cancelLabel when provided", () => {
      renderDialog({ cancelLabel: "No, keep it" });
      expect(screen.getByRole("button", { name: /no, keep it/i })).toBeInTheDocument();
    });
  });

  describe("confirm button", () => {
    it("calls onConfirm when the confirm button is clicked", async () => {
      const onConfirm = vi.fn();
      renderDialog({ onConfirm });

      await user.click(screen.getByRole("button", { name: /delete/i }));

      expect(onConfirm).toHaveBeenCalledTimes(1);
    });

    it("renders the default confirmLabel 'Delete'", () => {
      renderDialog();
      expect(screen.getByRole("button", { name: /^delete$/i })).toBeInTheDocument();
    });

    it("renders a custom confirmLabel when provided", () => {
      renderDialog({ confirmLabel: "Confirm archive" });
      expect(screen.getByRole("button", { name: /confirm archive/i })).toBeInTheDocument();
    });
  });

  describe("isLoading=true", () => {
    it("disables the cancel and confirm buttons when isLoading is true", () => {
      renderDialog({ isLoading: true });

      // Query the two explicit dialog footer buttons by their visible text / aria-label.
      // Radix Dialog may add its own close button which is separate from the footer actions.
      expect(screen.getByRole("button", { name: /cancel/i })).toBeDisabled();
      // The confirm button shows "Processing..." when loading
      expect(screen.getByRole("button", { name: /processing/i })).toBeDisabled();
    });

    it("shows spinner text on the confirm button when isLoading", () => {
      renderDialog({ isLoading: true });
      // The confirm button shows "Processing..." when loading
      expect(screen.getByText(/processing/i)).toBeInTheDocument();
    });

    it("renders the confirm button with aria-busy=true when loading", () => {
      renderDialog({ isLoading: true });
      // The destructive button carries aria-busy
      const buttons = screen.getAllByRole("button");
      const confirmBtn = buttons.find((b) => b.getAttribute("aria-busy") === "true");
      expect(confirmBtn).toBeDefined();
    });
  });
});
