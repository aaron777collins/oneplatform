/**
 * Tests for TemplateGallery component
 *
 * Covers:
 * - Step 1: trigger selector renders all options, advancing to step 2
 * - Step 2: name input validates empty, advancing to step 3
 * - Step 3: template cards render, selecting a template calls onComplete
 * - Step 3: "Start blank" calls onComplete with undefined graph
 * - Cancel calls onCancel
 * - Wizard step indicator updates as the user progresses
 * - Back navigation works on steps 2 and 3
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { TemplateGallery } from "@/components/pipeline-editor/TemplateGallery.js";
import { PIPELINE_TEMPLATES } from "@/components/pipeline-editor/pipeline-templates.js";
import type { TemplateGalleryResult } from "@/components/pipeline-editor/TemplateGallery.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderGallery(
  overrides: {
    onComplete?: (result: TemplateGalleryResult) => void;
    onCancel?: () => void;
  } = {},
) {
  const onComplete = overrides.onComplete ?? vi.fn();
  const onCancel = overrides.onCancel ?? vi.fn();
  return {
    ...render(<TemplateGallery onComplete={onComplete} onCancel={onCancel} />),
    onComplete,
    onCancel,
  };
}

/** Navigate from step 1 to step 2 */
async function advanceToStep2(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /^next$/i }));
}

/** Navigate from step 2 to step 3 with a given pipeline name */
async function advanceToStep3(
  user: ReturnType<typeof userEvent.setup>,
  pipelineName = "My Pipeline",
) {
  const input = screen.getByRole("textbox", { name: /pipeline name/i });
  await user.clear(input);
  await user.type(input, pipelineName);
  await user.click(screen.getByRole("button", { name: /^next$/i }));
}

// ---------------------------------------------------------------------------
// Step 1 — Trigger type
// ---------------------------------------------------------------------------

describe("TemplateGallery — Step 1: Trigger", () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    user = userEvent.setup();
  });

  it("renders the step 1 heading", () => {
    renderGallery();
    expect(screen.getByText(/what triggers this pipeline/i)).toBeInTheDocument();
  });

  it("renders all three trigger options", () => {
    renderGallery();
    expect(screen.getByRole("radio", { name: /manual/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /schedule/i })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /webhook/i })).toBeInTheDocument();
  });

  it("Manual is selected by default", () => {
    renderGallery();
    expect(screen.getByRole("radio", { name: /manual/i })).toHaveAttribute("aria-checked", "true");
  });

  it("clicking a trigger option selects it", async () => {
    renderGallery();
    await user.click(screen.getByRole("radio", { name: /schedule/i }));
    expect(screen.getByRole("radio", { name: /schedule/i })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: /manual/i })).toHaveAttribute("aria-checked", "false");
  });

  it("clicking Next advances to step 2", async () => {
    renderGallery();
    await advanceToStep2(user);
    expect(screen.getByText(/give it a name/i)).toBeInTheDocument();
  });

  it("renders the Cancel button", () => {
    renderGallery();
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("Cancel calls onCancel", async () => {
    const { onCancel } = renderGallery();
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Step 2 — Pipeline name
// ---------------------------------------------------------------------------

describe("TemplateGallery — Step 2: Name", () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    user = userEvent.setup();
  });

  async function renderAtStep2() {
    const result = renderGallery();
    await advanceToStep2(user);
    return result;
  }

  it("renders the step 2 heading", async () => {
    await renderAtStep2();
    expect(screen.getByText(/give it a name/i)).toBeInTheDocument();
  });

  it("renders the pipeline name input", async () => {
    await renderAtStep2();
    expect(screen.getByRole("textbox", { name: /pipeline name/i })).toBeInTheDocument();
  });

  it("shows an error when Next is clicked with an empty name", async () => {
    await renderAtStep2();
    // Input is empty by default
    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText(/pipeline name is required/i)).toBeInTheDocument();
  });

  it("clears the error once the user types a name", async () => {
    await renderAtStep2();
    await user.click(screen.getByRole("button", { name: /^next$/i }));
    expect(screen.getByRole("alert")).toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: /pipeline name/i }), "My Pipeline");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("advances to step 3 after entering a valid name", async () => {
    await renderAtStep2();
    await advanceToStep3(user, "Sync Customers");
    expect(screen.getByText(/choose a template/i)).toBeInTheDocument();
  });

  it("pressing Enter in the name input advances to step 3", async () => {
    await renderAtStep2();
    await user.type(screen.getByRole("textbox", { name: /pipeline name/i }), "Quick Enter Pipeline{Enter}");
    expect(screen.getByText(/choose a template/i)).toBeInTheDocument();
  });

  it("Back button returns to step 1", async () => {
    await renderAtStep2();
    await user.click(screen.getByRole("button", { name: /back/i }));
    expect(screen.getByText(/what triggers this pipeline/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Step 3 — Template selection
// ---------------------------------------------------------------------------

describe("TemplateGallery — Step 3: Template", () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    user = userEvent.setup();
  });

  async function renderAtStep3(pipelineName = "Test Pipeline") {
    const result = renderGallery();
    await advanceToStep2(user);
    await advanceToStep3(user, pipelineName);
    return result;
  }

  it("renders the step 3 heading", async () => {
    await renderAtStep3();
    expect(screen.getByText(/choose a template/i)).toBeInTheDocument();
  });

  it("renders a card for every pipeline template", async () => {
    await renderAtStep3();
    for (const template of PIPELINE_TEMPLATES) {
      expect(screen.getByRole("button", { name: new RegExp(template.name, "i") })).toBeInTheDocument();
    }
  });

  it("renders the 'Start blank' option", async () => {
    await renderAtStep3();
    expect(screen.getByRole("button", { name: /blank canvas/i })).toBeInTheDocument();
  });

  it("selecting a template calls onComplete with the template graph", async () => {
    const { onComplete } = await renderAtStep3("Enrichment Run");
    const firstTemplate = PIPELINE_TEMPLATES[0]!;

    await user.click(
      screen.getByRole("button", { name: new RegExp(`use template.*${firstTemplate.name}`, "i") }),
    );

    expect(onComplete).toHaveBeenCalledOnce();
    const result = onComplete.mock.calls[0]![0] as TemplateGalleryResult;
    expect(result.name).toBe("Enrichment Run");
    expect(result.graph).toEqual(firstTemplate.graph);
  });

  it("selecting a template passes the wizard trigger type to onComplete", async () => {
    const { onComplete } = renderGallery();

    // Step 1 — choose cron
    await user.click(screen.getByRole("radio", { name: /schedule/i }));
    await advanceToStep2(user);

    // Step 2
    await advanceToStep3(user, "Scheduled Run");

    // Step 3 — pick first template
    const firstTemplate = PIPELINE_TEMPLATES[0]!;
    await user.click(
      screen.getByRole("button", { name: new RegExp(`use template.*${firstTemplate.name}`, "i") }),
    );

    const result = onComplete.mock.calls[0]![0] as TemplateGalleryResult;
    expect(result.triggerType).toBe("cron");
  });

  it("'Start blank' calls onComplete with undefined graph", async () => {
    const { onComplete } = await renderAtStep3("Blank Run");
    await user.click(screen.getByRole("button", { name: /blank canvas/i }));

    expect(onComplete).toHaveBeenCalledOnce();
    const result = onComplete.mock.calls[0]![0] as TemplateGalleryResult;
    expect(result.graph).toBeUndefined();
    expect(result.name).toBe("Blank Run");
  });

  it("Back button returns to step 2", async () => {
    await renderAtStep3();
    await user.click(screen.getByRole("button", { name: /back/i }));
    expect(screen.getByText(/give it a name/i)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

describe("TemplateGallery — step indicator", () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    user = userEvent.setup();
  });

  it("step 1 is aria-current=step initially", () => {
    renderGallery();
    // The step indicator uses aria-current="step" on the active step circle
    const step1 = screen.getByText("1");
    expect(step1).toHaveAttribute("aria-current", "step");
  });

  it("step 2 becomes aria-current=step after advancing", async () => {
    renderGallery();
    await advanceToStep2(user);
    const step2 = screen.getByText("2");
    expect(step2).toHaveAttribute("aria-current", "step");
  });

  it("step 3 becomes aria-current=step on the template screen", async () => {
    renderGallery();
    await advanceToStep2(user);
    await advanceToStep3(user, "Some Pipeline");
    const step3 = screen.getByText("3");
    expect(step3).toHaveAttribute("aria-current", "step");
  });
});
