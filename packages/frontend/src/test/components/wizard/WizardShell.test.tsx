/**
 * WizardShell tests
 *
 * Seeds the wizard Zustand store directly to put it in the desired step
 * before rendering. Each step component is mocked to a minimal stub so
 * this test stays focused on the shell's progress-indicator logic and
 * step routing — not the step content itself.
 *
 * SuccessStep uses Link from @tanstack/react-router, so the router is
 * mocked globally.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { WizardShell } from "@/components/wizard/WizardShell.js";
import { useWizardStore } from "@/stores/wizard.store.js";

// ---------------------------------------------------------------------------
// TanStack Router mock — SuccessStep renders a <Link to="/login">
// ---------------------------------------------------------------------------

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...props }: React.PropsWithChildren<{ to: string }>) =>
    React.createElement("a", { href: to, ...props }, children),
  useNavigate: () => vi.fn(),
  useMatchRoute: () => () => false,
}));

// ---------------------------------------------------------------------------
// Step component mocks
// Each stub renders a unique data-testid so assertions are unambiguous.
// ---------------------------------------------------------------------------

vi.mock("@/components/wizard/steps/WelcomeStep.js", () => ({
  WelcomeStep: () => <div data-testid="step-welcome">WelcomeStep</div>,
}));

vi.mock("@/components/wizard/steps/AdminAccountStep.js", () => ({
  AdminAccountStep: () => <div data-testid="step-admin-account">AdminAccountStep</div>,
}));

vi.mock("@/components/wizard/steps/OrgNameStep.js", () => ({
  OrgNameStep: () => <div data-testid="step-org-name">OrgNameStep</div>,
}));

vi.mock("@/components/wizard/steps/MasterKeyStep.js", () => ({
  MasterKeyStep: () => <div data-testid="step-master-key">MasterKeyStep</div>,
}));

vi.mock("@/components/wizard/steps/ReviewStep.js", () => ({
  ReviewStep: () => <div data-testid="step-review">ReviewStep</div>,
}));

vi.mock("@/components/wizard/steps/SuccessStep.js", () => ({
  SuccessStep: () => <div data-testid="step-success">SuccessStep</div>,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderShell() {
  return render(<WizardShell bootstrapToken="tok-abc" />);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WizardShell", () => {
  beforeEach(() => {
    // Each test starts from a clean store
    useWizardStore.getState().reset();
  });

  afterEach(() => {
    useWizardStore.getState().reset();
  });

  describe("step 0 — Welcome", () => {
    it("renders WelcomeStep when currentStep is 0", () => {
      renderShell();
      expect(screen.getByTestId("step-welcome")).toBeInTheDocument();
    });

    it("renders the progress nav for step 0", () => {
      renderShell();
      expect(screen.getByRole("navigation", { name: /setup progress/i })).toBeInTheDocument();
    });

    it("first progress item has aria-current='step'", () => {
      renderShell();
      const listItems = screen.getAllByRole("listitem");
      // The first visible <li> corresponds to step 0
      const firstStep = listItems[0];
      expect(firstStep).toHaveAttribute("aria-current", "step");
    });

    it("subsequent progress items do not have aria-current", () => {
      renderShell();
      const listItems = screen.getAllByRole("listitem");
      // Items after index 0 must not carry aria-current
      for (const item of listItems.slice(1)) {
        expect(item).not.toHaveAttribute("aria-current");
      }
    });
  });

  describe("step 3 — progress indicator active item", () => {
    beforeEach(() => {
      useWizardStore.getState().goToStep(3);
    });

    it("renders MasterKeyStep when currentStep is 3", () => {
      renderShell();
      expect(screen.getByTestId("step-master-key")).toBeInTheDocument();
    });

    it("fourth progress item (index 3) has aria-current='step'", () => {
      renderShell();
      const listItems = screen.getAllByRole("listitem");
      expect(listItems[3]).toHaveAttribute("aria-current", "step");
    });

    it("other progress items do not have aria-current when step is 3", () => {
      renderShell();
      const listItems = screen.getAllByRole("listitem");
      for (let i = 0; i < listItems.length; i++) {
        if (i === 3) continue;
        expect(listItems[i]).not.toHaveAttribute("aria-current");
      }
    });
  });

  describe("step 5 — SuccessStep", () => {
    beforeEach(() => {
      useWizardStore.getState().goToStep(5);
    });

    it("renders SuccessStep when currentStep is 5", () => {
      renderShell();
      expect(screen.getByTestId("step-success")).toBeInTheDocument();
    });

    it("hides the progress nav on step 5", () => {
      renderShell();
      expect(
        screen.queryByRole("navigation", { name: /setup progress/i }),
      ).not.toBeInTheDocument();
    });
  });
});
