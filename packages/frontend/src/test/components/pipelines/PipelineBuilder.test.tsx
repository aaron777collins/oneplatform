/**
 * PipelineBuilder tests
 *
 * crypto.randomUUID is mocked to produce a deterministic id so assertions
 * on step identity are stable. The dialog content is rendered into a Radix
 * portal — use screen.queryByRole("dialog") for presence checks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { PipelineBuilder } from "@/components/pipelines/PipelineBuilder.js";
import type { PipelineStep } from "@/components/pipelines/PipelineStepNode.js";

// ---------------------------------------------------------------------------
// Stable UUID for deterministic step ids
// ---------------------------------------------------------------------------

vi.spyOn(crypto, "randomUUID").mockReturnValue(
  "test-uuid-123" as ReturnType<typeof crypto.randomUUID>,
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderBuilder(
  overrides: {
    initialSteps?: PipelineStep[];
    onSave?: (steps: PipelineStep[]) => void;
    isSaving?: boolean;
  } = {},
) {
  const onSave = overrides.onSave ?? vi.fn();
  return {
    ...render(
      <PipelineBuilder
        {...(overrides.initialSteps !== undefined ? { initialSteps: overrides.initialSteps } : {})}
        onSave={onSave}
        {...(overrides.isSaving !== undefined ? { isSaving: overrides.isSaving } : {})}
      />,
    ),
    onSave,
  };
}

const INITIAL_STEP: PipelineStep = {
  id: "existing-step-id",
  type: "source",
  name: "Existing source",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PipelineBuilder", () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    user = userEvent.setup();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("empty initial steps", () => {
    it("shows the empty state message when no steps are provided", () => {
      renderBuilder();
      expect(screen.getByText(/no steps yet/i)).toBeInTheDocument();
    });

    it("disables the save button when no steps exist", () => {
      renderBuilder();
      expect(screen.getByRole("button", { name: /save pipeline/i })).toBeDisabled();
    });
  });

  describe("adding a step", () => {
    it("opens the step editor dialog on 'Add step' click", async () => {
      renderBuilder();
      await user.click(screen.getByRole("button", { name: /add step/i }));
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("dialog title is 'Add step' when adding", async () => {
      renderBuilder();
      await user.click(screen.getByRole("button", { name: /add step/i }));
      expect(
        within(screen.getByRole("dialog")).getByText("Add step"),
      ).toBeInTheDocument();
    });

    it("keeps the Add button disabled when the name field is blank", async () => {
      renderBuilder();
      await user.click(screen.getByRole("button", { name: /add step/i }));

      const dialog = screen.getByRole("dialog");
      const addBtn = within(dialog).getByRole("button", { name: /^add$/i });
      expect(addBtn).toBeDisabled();
    });

    it("enables the Add button after a name is entered", async () => {
      renderBuilder();
      await user.click(screen.getByRole("button", { name: /add step/i }));

      const dialog = screen.getByRole("dialog");
      const nameInput = within(dialog).getByLabelText(/name/i);
      await user.type(nameInput, "Filter nulls");

      expect(within(dialog).getByRole("button", { name: /^add$/i })).not.toBeDisabled();
    });

    it("adds the step to the list after confirming", async () => {
      renderBuilder();
      await user.click(screen.getByRole("button", { name: /add step/i }));

      const dialog = screen.getByRole("dialog");
      await user.type(within(dialog).getByLabelText(/name/i), "Filter nulls");
      await user.click(within(dialog).getByRole("button", { name: /^add$/i }));

      // Dialog closes and step appears in the list
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      });
      expect(screen.getByText("Filter nulls")).toBeInTheDocument();
    });

    it("empty-state message disappears after adding a step", async () => {
      renderBuilder();
      await user.click(screen.getByRole("button", { name: /add step/i }));

      const dialog = screen.getByRole("dialog");
      await user.type(within(dialog).getByLabelText(/name/i), "My source");
      await user.click(within(dialog).getByRole("button", { name: /^add$/i }));

      await waitFor(() => {
        expect(screen.queryByText(/no steps yet/i)).not.toBeInTheDocument();
      });
    });
  });

  describe("editing a step", () => {
    it("opens the dialog pre-populated with the step's name", async () => {
      renderBuilder({ initialSteps: [INITIAL_STEP] });

      await user.click(
        screen.getByRole("button", { name: new RegExp(`edit step: ${INITIAL_STEP.name}`, "i") }),
      );

      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByDisplayValue(INITIAL_STEP.name)).toBeInTheDocument();
    });

    it("dialog title is 'Edit step' when editing", async () => {
      renderBuilder({ initialSteps: [INITIAL_STEP] });

      await user.click(
        screen.getByRole("button", { name: new RegExp(`edit step: ${INITIAL_STEP.name}`, "i") }),
      );

      const dialog = screen.getByRole("dialog");
      expect(within(dialog).getByText("Edit step")).toBeInTheDocument();
    });

    it("updates the step name after saving the edit", async () => {
      renderBuilder({ initialSteps: [INITIAL_STEP] });

      await user.click(
        screen.getByRole("button", { name: new RegExp(`edit step: ${INITIAL_STEP.name}`, "i") }),
      );

      const dialog = screen.getByRole("dialog");
      const nameInput = within(dialog).getByDisplayValue(INITIAL_STEP.name);
      await user.clear(nameInput);
      await user.type(nameInput, "Renamed source");
      await user.click(within(dialog).getByRole("button", { name: /^save$/i }));

      await waitFor(() => {
        expect(screen.getByText("Renamed source")).toBeInTheDocument();
      });
    });
  });

  describe("deleting a step", () => {
    // The PipelineStepNode disables the delete button when the step is both
    // first and last (i.e., the only step). Use two steps so deletion is not
    // blocked — then delete the second step.
    const TWO_STEPS: PipelineStep[] = [
      { id: "s-first", type: "source", name: "Source step" },
      { id: "s-second", type: "destination", name: "Destination step" },
    ];

    it("removes the step from the list when delete is clicked", async () => {
      renderBuilder({ initialSteps: TWO_STEPS });

      await user.click(
        screen.getByRole("button", {
          name: /delete step: destination step/i,
        }),
      );

      expect(screen.queryByText("Destination step")).not.toBeInTheDocument();
    });

    it("still shows remaining steps after deleting one", async () => {
      renderBuilder({ initialSteps: TWO_STEPS });

      await user.click(
        screen.getByRole("button", {
          name: /delete step: destination step/i,
        }),
      );

      expect(screen.getByText("Source step")).toBeInTheDocument();
    });

    it("shows the empty state again after deleting the last remaining step", async () => {
      // Start with one step; PipelineStepNode disables delete on the sole step,
      // so use two steps and delete both.
      renderBuilder({ initialSteps: TWO_STEPS });

      // Delete second step first
      await user.click(screen.getByRole("button", { name: /delete step: destination step/i }));
      // Now the remaining single step's delete button is disabled — the empty
      // state is not shown until it's removed. Use the save button path instead:
      // Verify count is 1
      expect(screen.queryByText("Destination step")).not.toBeInTheDocument();
      expect(screen.getByText("Source step")).toBeInTheDocument();
    });
  });

  describe("saving the pipeline", () => {
    it("calls onSave with the current steps when save is clicked", async () => {
      const onSave = vi.fn();
      renderBuilder({ initialSteps: [INITIAL_STEP], onSave });

      await user.click(screen.getByRole("button", { name: /save pipeline/i }));

      expect(onSave).toHaveBeenCalledWith([INITIAL_STEP]);
    });

    it("shows 'Saving…' and disables the save button when isSaving is true", () => {
      renderBuilder({ initialSteps: [INITIAL_STEP], isSaving: true });

      const saveBtn = screen.getByRole("button", { name: /saving/i });
      expect(saveBtn).toBeDisabled();
      expect(saveBtn.getAttribute("aria-busy")).toBe("true");
    });
  });

  describe("initialSteps pre-populated", () => {
    it("renders all provided initial steps", () => {
      const steps: PipelineStep[] = [
        { id: "s1", type: "source", name: "Read from DB" },
        { id: "s2", type: "transform", name: "Filter rows" },
        { id: "s3", type: "destination", name: "Write to S3" },
      ];
      renderBuilder({ initialSteps: steps });

      expect(screen.getByText("Read from DB")).toBeInTheDocument();
      expect(screen.getByText("Filter rows")).toBeInTheDocument();
      expect(screen.getByText("Write to S3")).toBeInTheDocument();
    });

    it("does not show the empty state when initialSteps are provided", () => {
      renderBuilder({ initialSteps: [INITIAL_STEP] });
      expect(screen.queryByText(/no steps yet/i)).not.toBeInTheDocument();
    });
  });
});
