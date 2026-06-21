/**
 * Tests for NodePalette component
 *
 * Covers:
 * - Renders all step types
 * - Search/filter narrows the list
 * - Keyboard-driven add fires onAdd callback
 * - Each item is draggable (has draggable attribute)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { NodePalette } from "@/components/pipeline-editor/NodePalette.js";

const ALL_STEP_LABELS = [
  "Code",
  "Connector",
  "Transformer",
  "Transform",
  "Conditional",
  "Parallel",
  "Webhook",
  "Wait",
  "Approval",
  "Sub-workflow",
];

function renderPalette(onAdd = vi.fn()) {
  return { ...render(<NodePalette onAdd={onAdd} />), onAdd };
}

describe("NodePalette", () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    user = userEvent.setup();
  });

  describe("rendering", () => {
    it("renders a list item for every step type", () => {
      renderPalette();
      for (const label of ALL_STEP_LABELS) {
        expect(screen.getByText(label)).toBeInTheDocument();
      }
    });

    it("renders the search input", () => {
      renderPalette();
      expect(screen.getByRole("textbox", { name: /filter step types/i })).toBeInTheDocument();
    });

    it("renders the section heading", () => {
      renderPalette();
      expect(screen.getByText(/^steps$/i)).toBeInTheDocument();
    });

    it("each item has draggable attribute set to true", () => {
      renderPalette();
      // All draggable items have role="button"
      const buttons = screen.getAllByRole("button");
      const draggable = buttons.filter((b) => b.getAttribute("draggable") === "true");
      // There should be at least as many draggable items as step types
      expect(draggable.length).toBeGreaterThanOrEqual(ALL_STEP_LABELS.length);
    });
  });

  describe("search/filter", () => {
    it("filters items by label match", async () => {
      renderPalette();
      const searchInput = screen.getByRole("textbox", { name: /filter step types/i });
      await user.type(searchInput, "code");

      expect(screen.getByText("Code")).toBeInTheDocument();
      // Non-matching items should be removed
      expect(screen.queryByText("Wait")).not.toBeInTheDocument();
    });

    it("filters case-insensitively", async () => {
      renderPalette();
      await user.type(screen.getByRole("textbox", { name: /filter step types/i }), "WEBHOOK");

      expect(screen.getByText("Webhook")).toBeInTheDocument();
    });

    it("shows 'No matching steps' when nothing matches", async () => {
      renderPalette();
      await user.type(
        screen.getByRole("textbox", { name: /filter step types/i }),
        "zzznomatch"
      );

      expect(screen.getByText(/no matching steps/i)).toBeInTheDocument();
    });

    it("restores all items when search is cleared", async () => {
      renderPalette();
      const input = screen.getByRole("textbox", { name: /filter step types/i });
      await user.type(input, "code");
      await user.clear(input);

      for (const label of ALL_STEP_LABELS) {
        expect(screen.getByText(label)).toBeInTheDocument();
      }
    });

    it("filters by description text too", async () => {
      renderPalette();
      await user.type(
        screen.getByRole("textbox", { name: /filter step types/i }),
        "javascript"
      );
      // "Code" description mentions "JavaScript"
      expect(screen.getByText("Code")).toBeInTheDocument();
    });
  });

  describe("keyboard add", () => {
    it("calls onAdd with the step type when Enter is pressed on an item", async () => {
      const onAdd = vi.fn();
      renderPalette(onAdd);

      // Focus the Code item and press Enter
      const codeButton = screen.getByRole("button", { name: /add code step/i });
      codeButton.focus();
      await user.keyboard("{Enter}");

      expect(onAdd).toHaveBeenCalledOnce();
      expect(onAdd).toHaveBeenCalledWith("code");
    });

    it("calls onAdd with the step type when Space is pressed on an item", async () => {
      const onAdd = vi.fn();
      renderPalette(onAdd);

      const waitButton = screen.getByRole("button", { name: /add wait step/i });
      waitButton.focus();
      await user.keyboard(" ");

      expect(onAdd).toHaveBeenCalledOnce();
      expect(onAdd).toHaveBeenCalledWith("wait");
    });

    it("calls onAdd when item is clicked", async () => {
      const onAdd = vi.fn();
      renderPalette(onAdd);

      await user.click(screen.getByRole("button", { name: /add approval step/i }));

      expect(onAdd).toHaveBeenCalledWith("approval");
    });
  });
});
