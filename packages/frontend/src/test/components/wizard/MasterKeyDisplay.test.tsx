/**
 * MasterKeyDisplay tests
 *
 * Two groups of tests use different timer strategies:
 * - Interaction tests (show/hide, checkbox) use real timers + fireEvent so
 *   there is no conflict between userEvent's internal scheduling and fake timers.
 * - Timer/countdown tests use vi.useFakeTimers() + vi.advanceTimersByTimeAsync()
 *   wrapped in act() to drive the 60-second countdown deterministically.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import React from "react";
import { MasterKeyDisplay } from "@/components/wizard/MasterKeyDisplay.js";

// ---------------------------------------------------------------------------
// Clipboard mock — jsdom does not implement navigator.clipboard
// ---------------------------------------------------------------------------

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

const TEST_KEY = "super-secret-master-key-value-abc123";

function renderComponent(
  overrides: Partial<{
    masterKey: string;
    acknowledged: boolean;
    onAcknowledgedChange: (v: boolean) => void;
  }> = {},
) {
  const props = {
    masterKey: TEST_KEY,
    acknowledged: false,
    onAcknowledgedChange: vi.fn(),
    ...overrides,
  };
  return { ...render(<MasterKeyDisplay {...props} />), props };
}

// ---------------------------------------------------------------------------
// Tests — initial state (real timers)
// ---------------------------------------------------------------------------

describe("MasterKeyDisplay", () => {
  describe("initial state", () => {
    it("does not display the key text on first render — shows dots instead", () => {
      const { props } = renderComponent();
      const keyBox = screen.getByRole("textbox", { name: /master encryption key/i });
      expect(keyBox).not.toHaveTextContent(props.masterKey);
      expect(keyBox.textContent).toMatch(/^•+$/);
    });

    it("renders the show/hide toggle button", () => {
      renderComponent();
      expect(screen.getByRole("button", { name: /show master key/i })).toBeInTheDocument();
    });

    it("acknowledgment checkbox is unchecked by default", () => {
      renderComponent();
      expect(screen.getByRole("checkbox")).not.toBeChecked();
    });

    it("renders the countdown timer text", () => {
      renderComponent();
      expect(screen.getByText(/key will be hidden in/i)).toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // Interaction tests — use real timers + fireEvent
  // -------------------------------------------------------------------------

  describe("show/hide toggle", () => {
    it("reveals the key text after clicking show", () => {
      const { props } = renderComponent();

      fireEvent.click(screen.getByRole("button", { name: /show master key/i }));

      const keyBox = screen.getByRole("textbox", { name: /master encryption key/i });
      expect(keyBox).toHaveTextContent(props.masterKey);
    });

    it("changes toggle aria-label to 'Hide master key' when visible", () => {
      renderComponent();

      fireEvent.click(screen.getByRole("button", { name: /show master key/i }));

      expect(screen.getByRole("button", { name: /hide master key/i })).toBeInTheDocument();
    });

    it("masks the key again after toggling hide", () => {
      const { props } = renderComponent();

      fireEvent.click(screen.getByRole("button", { name: /show master key/i }));
      fireEvent.click(screen.getByRole("button", { name: /hide master key/i }));

      const keyBox = screen.getByRole("textbox", { name: /master encryption key/i });
      expect(keyBox).not.toHaveTextContent(props.masterKey);
      expect(keyBox.textContent).toMatch(/^•+$/);
    });
  });

  describe("acknowledgment checkbox", () => {
    it("calls onAcknowledgedChange(true) when checked", () => {
      const onAcknowledgedChange = vi.fn();
      renderComponent({ onAcknowledgedChange });

      fireEvent.click(screen.getByRole("checkbox"));

      expect(onAcknowledgedChange).toHaveBeenCalledWith(true);
    });

    it("calls onAcknowledgedChange(false) when unchecked", () => {
      const onAcknowledgedChange = vi.fn();
      renderComponent({ acknowledged: true, onAcknowledgedChange });

      fireEvent.click(screen.getByRole("checkbox"));

      expect(onAcknowledgedChange).toHaveBeenCalledWith(false);
    });
  });

  // -------------------------------------------------------------------------
  // Timer tests — fake timers
  //
  // The component uses a chain of single 1-second setTimeout calls (one per
  // render cycle), so advancing by N seconds at once only fires the first
  // pending timeout. Each second must be advanced individually inside act()
  // so that React processes the state update and registers the next timeout
  // before the following tick.
  // -------------------------------------------------------------------------

  /**
   * Advances the fake clock by `n` seconds, one tick at a time, flushing
   * React state updates between each tick.
   */
  async function advanceTicks(n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }
  }

  describe("countdown announcements", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("announces '30 seconds remaining' in sr-only live region at the 30s threshold", async () => {
      renderComponent();

      // Tick 31 times: countdown 60 → 29, announcement fires when next === 30
      // (CopyButton also renders an aria-live="polite" region — query all and
      // assert at least one contains the expected text.)
      await advanceTicks(31);

      const liveRegions = document.querySelectorAll("[aria-live='polite']");
      const texts = Array.from(liveRegions).map((el) => el.textContent ?? "");
      expect(texts.some((t) => t.includes("30 seconds remaining"))).toBe(true);
    }, 15_000);

    it("announces '10 seconds remaining' in sr-only live region at the 10s threshold", async () => {
      renderComponent();

      // Tick 51 times: countdown 60 → 9, announcement fires when next === 10
      await advanceTicks(51);

      const liveRegions = document.querySelectorAll("[aria-live='polite']");
      const texts = Array.from(liveRegions).map((el) => el.textContent ?? "");
      expect(texts.some((t) => t.includes("10 seconds remaining"))).toBe(true);
    }, 20_000);
  });

  describe("expiry at 60 seconds", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    it("removes the key textbox from the DOM after 60 seconds", async () => {
      renderComponent();

      await advanceTicks(60);

      expect(
        screen.queryByRole("textbox", { name: /master encryption key/i }),
      ).not.toBeInTheDocument();
    }, 25_000);

    it("removes the show/hide toggle button after expiry", async () => {
      renderComponent();

      await advanceTicks(60);

      expect(screen.queryByRole("button", { name: /show master key/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /hide master key/i })).not.toBeInTheDocument();
    }, 25_000);

    it("shows the expiry alert with role=alert after 60 seconds", async () => {
      renderComponent();

      await advanceTicks(60);

      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByRole("alert")).toHaveTextContent(/key display expired/i);
    }, 25_000);
  });
});
