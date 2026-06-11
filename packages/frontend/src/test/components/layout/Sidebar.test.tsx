/**
 * Sidebar tests
 *
 * The router is mocked so the component renders without a real router context.
 * useMatchRoute returns a function that compares to `currentPath`, which each
 * test sets before rendering.
 *
 * localStorage is stubbed via vi.stubGlobal so we control both read and write
 * behaviour without relying on the jsdom implementation.
 *
 * Role-gating is exercised by seeding the auth store directly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { Sidebar } from "@/components/layout/Sidebar.js";
import { useAuthStore } from "@/stores/auth.store.js";

// ---------------------------------------------------------------------------
// Router mock
// ---------------------------------------------------------------------------

let currentPath = "/";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: React.PropsWithChildren<{ to: string; [k: string]: unknown }>) =>
    React.createElement("a", { href: to, ...props }, children),
  useMatchRoute: () => (opts: { to: string }) => opts.to === currentPath,
  useNavigate: () => vi.fn(),
}));

// ---------------------------------------------------------------------------
// localStorage stub
// localStorage in jsdom does not implement .clear() reliably in some vitest
// environments, so we stub it with an in-memory map.
// ---------------------------------------------------------------------------

let localStore: Record<string, string> = {};

const localStorageMock = {
  getItem: (key: string) => localStore[key] ?? null,
  setItem: (key: string, value: string) => {
    localStore[key] = value;
  },
  removeItem: (key: string) => {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete localStore[key];
  },
  clear: () => {
    localStore = {};
  },
};

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
  currentPath = "/";
  localStore = {};
  vi.stubGlobal("localStorage", localStorageMock);
  // Default: viewer role
  seedRoles(["viewer"]);
});

afterEach(() => {
  useAuthStore.setState({ ...CLEARED_AUTH }, true);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Sidebar", () => {
  const user = userEvent.setup();

  describe("viewer role", () => {
    beforeEach(() => {
      seedRoles(["viewer"]);
    });

    it("renders Overview link", () => {
      render(<Sidebar />);
      expect(screen.getByRole("link", { name: /overview/i })).toBeInTheDocument();
    });

    it("does not render the DLQ link (requires data-engineer)", () => {
      render(<Sidebar />);
      expect(screen.queryByRole("link", { name: /dlq/i })).not.toBeInTheDocument();
    });

    it("does not render the Metrics link (requires data-engineer)", () => {
      render(<Sidebar />);
      expect(screen.queryByRole("link", { name: /metrics/i })).not.toBeInTheDocument();
    });

    it("renders the Logs link (no role restriction)", () => {
      render(<Sidebar />);
      expect(screen.getByRole("link", { name: /^logs$/i })).toBeInTheDocument();
    });
  });

  describe("data-engineer role", () => {
    beforeEach(() => {
      seedRoles(["data-engineer"]);
    });

    it("renders DLQ link", () => {
      render(<Sidebar />);
      expect(screen.getByRole("link", { name: /dlq/i })).toBeInTheDocument();
    });

    it("renders Metrics link", () => {
      render(<Sidebar />);
      expect(screen.getByRole("link", { name: /metrics/i })).toBeInTheDocument();
    });

    it("renders Overview link", () => {
      render(<Sidebar />);
      expect(screen.getByRole("link", { name: /overview/i })).toBeInTheDocument();
    });
  });

  describe("platform-admin role", () => {
    beforeEach(() => {
      seedRoles(["platform-admin"]);
    });

    it("renders all role-gated links: DLQ and Metrics", () => {
      render(<Sidebar />);
      expect(screen.getByRole("link", { name: /dlq/i })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /metrics/i })).toBeInTheDocument();
    });

    it("renders all expected navigation items", () => {
      render(<Sidebar />);
      expect(screen.getByRole("link", { name: /overview/i })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /connectors/i })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /pipelines/i })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /plugins/i })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /settings/i })).toBeInTheDocument();
    });
  });

  describe("collapse toggle", () => {
    it("renders the collapse button initially", () => {
      render(<Sidebar />);
      expect(
        screen.getByRole("button", { name: /collapse sidebar/i }),
      ).toBeInTheDocument();
    });

    it("changes the toggle button label to 'Expand sidebar' after collapsing", async () => {
      render(<Sidebar />);
      await user.click(screen.getByRole("button", { name: /collapse sidebar/i }));
      expect(
        screen.getByRole("button", { name: /expand sidebar/i }),
      ).toBeInTheDocument();
    });

    it("hides navigation link text labels when collapsed", async () => {
      render(<Sidebar />);
      // Text labels are visible before collapsing
      expect(screen.getByText("Overview")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /collapse sidebar/i }));

      // After collapse, the <span> text is removed (collapsed hides spans)
      expect(screen.queryByText("Overview")).not.toBeInTheDocument();
    });

    it("restores expanded state after toggling twice", async () => {
      render(<Sidebar />);
      await user.click(screen.getByRole("button", { name: /collapse sidebar/i }));
      await user.click(screen.getByRole("button", { name: /expand sidebar/i }));

      expect(
        screen.getByRole("button", { name: /collapse sidebar/i }),
      ).toBeInTheDocument();
    });
  });

  describe("localStorage persistence", () => {
    it("persists collapsed=true to localStorage after collapsing", async () => {
      render(<Sidebar />);
      await user.click(screen.getByRole("button", { name: /collapse sidebar/i }));
      expect(localStorageMock.getItem("op-sidebar-collapsed")).toBe("true");
    });

    it("persists collapsed=false to localStorage after expanding", async () => {
      localStore["op-sidebar-collapsed"] = "true";
      render(<Sidebar />);
      await user.click(screen.getByRole("button", { name: /expand sidebar/i }));
      expect(localStorageMock.getItem("op-sidebar-collapsed")).toBe("false");
    });

    it("reads collapsed=true from localStorage on initial render", () => {
      localStore["op-sidebar-collapsed"] = "true";
      render(<Sidebar />);
      // Collapsed on mount — expand button is visible instead of collapse
      expect(
        screen.getByRole("button", { name: /expand sidebar/i }),
      ).toBeInTheDocument();
    });
  });

  describe("active link", () => {
    it("marks the active link with aria-current='page'", () => {
      currentPath = "/connectors";
      render(<Sidebar />);
      expect(
        screen.getByRole("link", { name: /connectors/i }),
      ).toHaveAttribute("aria-current", "page");
    });

    it("does not mark inactive links with aria-current", () => {
      currentPath = "/connectors";
      render(<Sidebar />);
      expect(
        screen.getByRole("link", { name: /overview/i }),
      ).not.toHaveAttribute("aria-current");
    });
  });

  describe("navigation landmark", () => {
    it("wraps links in a primary navigation landmark", () => {
      render(<Sidebar />);
      expect(
        screen.getByRole("navigation", { name: /primary navigation/i }),
      ).toBeInTheDocument();
    });
  });
});
