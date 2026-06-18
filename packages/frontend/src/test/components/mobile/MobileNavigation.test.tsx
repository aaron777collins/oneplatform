/**
 * MobileNavigation tests.
 *
 * Router is mocked so we can control which path is "active" without a real
 * router context. Auth store is seeded directly via setState to test role-gating.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { MobileNavigation } from "@/components/mobile/MobileNavigation.js";
import { useAuthStore } from "@/stores/auth.store.js";

// ---------------------------------------------------------------------------
// Router mock
// ---------------------------------------------------------------------------

let currentPath = "/dashboard";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: React.PropsWithChildren<{ to: string; [k: string]: unknown }>) =>
    React.createElement("a", { href: to, ...props }, children),
  useMatchRoute: () => (opts: { to: string }) => opts.to === currentPath,
}));

// ---------------------------------------------------------------------------
// Auth store helpers
// ---------------------------------------------------------------------------

const CLEARED_AUTH = {
  userId: null as null,
  tenantId: null as null,
  roles: [] as string[],
  scopes: [] as string[],
  isGuest: false,
  emailVerified: false,
  isLoading: false,
  isAuthenticated: false,
};

function seedRoles(roles: string[]) {
  useAuthStore.setState({ ...CLEARED_AUTH, roles, isAuthenticated: true });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  currentPath = "/dashboard";
  seedRoles(["viewer"]);
});

afterEach(() => {
  useAuthStore.setState({ ...CLEARED_AUTH });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MobileNavigation", () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    user = userEvent.setup();
  });

  describe("primary tab bar", () => {
    it("renders the mobile navigation landmark", () => {
      render(<MobileNavigation />);
      expect(
        screen.getByRole("navigation", { name: /mobile navigation/i }),
      ).toBeInTheDocument();
    });

    it("renders all five primary tab items", () => {
      render(<MobileNavigation />);
      expect(screen.getByRole("link", { name: /dashboard/i })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /connectors/i })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /pipelines/i })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /apps/i })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /settings/i })).toBeInTheDocument();
    });

    it("marks the active tab with aria-current='page'", () => {
      currentPath = "/connectors";
      render(<MobileNavigation />);
      expect(
        screen.getByRole("link", { name: /connectors/i }),
      ).toHaveAttribute("aria-current", "page");
    });

    it("does not mark inactive tabs with aria-current", () => {
      currentPath = "/connectors";
      render(<MobileNavigation />);
      expect(
        screen.getByRole("link", { name: /dashboard/i }),
      ).not.toHaveAttribute("aria-current");
    });
  });

  describe("More button", () => {
    it("renders a 'More navigation items' button", () => {
      render(<MobileNavigation />);
      expect(
        screen.getByRole("button", { name: /more navigation items/i }),
      ).toBeInTheDocument();
    });

    it("opens the More sheet when clicked", async () => {
      render(<MobileNavigation />);
      await user.click(screen.getByRole("button", { name: /more navigation items/i }));
      expect(
        screen.getByRole("dialog", { name: /more navigation options/i }),
      ).toBeInTheDocument();
    });

    it("closes the More sheet when backdrop is clicked", async () => {
      render(<MobileNavigation />);
      await user.click(screen.getByRole("button", { name: /more navigation items/i }));

      // Click the backdrop (aria-hidden=true, so we need to target it by its
      // position in the DOM — it immediately precedes the dialog panel).
      const dialog = screen.getByRole("dialog", { name: /more navigation options/i });
      const backdrop = dialog.previousElementSibling as HTMLElement;
      await user.click(backdrop);

      expect(
        screen.queryByRole("dialog", { name: /more navigation options/i }),
      ).not.toBeInTheDocument();
    });

    it("closes the More sheet when a secondary link is clicked", async () => {
      render(<MobileNavigation />);
      await user.click(screen.getByRole("button", { name: /more navigation items/i }));

      // Ontology is always visible (no role restriction)
      await user.click(screen.getByRole("link", { name: /ontology/i }));

      expect(
        screen.queryByRole("dialog", { name: /more navigation options/i }),
      ).not.toBeInTheDocument();
    });

    it("sets aria-expanded on the More button when the sheet is open", async () => {
      render(<MobileNavigation />);
      const moreBtn = screen.getByRole("button", { name: /more navigation items/i });
      expect(moreBtn).toHaveAttribute("aria-expanded", "false");

      await user.click(moreBtn);
      expect(moreBtn).toHaveAttribute("aria-expanded", "true");
    });
  });

  describe("role-gating in More sheet", () => {
    it("hides DLQ from viewer role", async () => {
      seedRoles(["viewer"]);
      render(<MobileNavigation />);
      await user.click(screen.getByRole("button", { name: /more navigation items/i }));
      expect(screen.queryByRole("link", { name: /dlq/i })).not.toBeInTheDocument();
    });

    it("hides Metrics from viewer role", async () => {
      seedRoles(["viewer"]);
      render(<MobileNavigation />);
      await user.click(screen.getByRole("button", { name: /more navigation items/i }));
      expect(screen.queryByRole("link", { name: /metrics/i })).not.toBeInTheDocument();
    });

    it("shows DLQ for data-engineer role", async () => {
      seedRoles(["data-engineer"]);
      render(<MobileNavigation />);
      await user.click(screen.getByRole("button", { name: /more navigation items/i }));
      expect(screen.getByRole("link", { name: /dlq/i })).toBeInTheDocument();
    });

    it("shows Metrics for data-engineer role", async () => {
      seedRoles(["data-engineer"]);
      render(<MobileNavigation />);
      await user.click(screen.getByRole("button", { name: /more navigation items/i }));
      expect(screen.getByRole("link", { name: /metrics/i })).toBeInTheDocument();
    });

    it("shows all items for platform-admin role", async () => {
      seedRoles(["platform-admin"]);
      render(<MobileNavigation />);
      await user.click(screen.getByRole("button", { name: /more navigation items/i }));
      expect(screen.getByRole("link", { name: /dlq/i })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /metrics/i })).toBeInTheDocument();
    });
  });

  describe("tap target sizes", () => {
    it("primary tab links have the min-h-[3rem] class for 44px+ tap target", () => {
      render(<MobileNavigation />);
      const dashboardLink = screen.getByRole("link", { name: /dashboard/i });
      // Verify the Tailwind class is applied — the actual pixel size is a CSS
      // concern validated by visual testing; here we verify the class is present.
      expect(dashboardLink.className).toContain("min-h-[3rem]");
    });

    it("the More button has the min-h-[3rem] class for 44px+ tap target", () => {
      render(<MobileNavigation />);
      const moreBtn = screen.getByRole("button", { name: /more navigation items/i });
      expect(moreBtn.className).toContain("min-h-[3rem]");
    });
  });
});
