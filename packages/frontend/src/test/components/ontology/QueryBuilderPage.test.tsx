/**
 * QueryBuilderPage tests
 *
 * These tests cover rendering and interactive behaviour of the query builder UI.
 * The API client is mocked so no network requests are made. TanStack Router and
 * TanStack Query are stubbed with minimal test-friendly wrappers.
 *
 * The Radix UI Select component relies on pointer-capture APIs that jsdom does
 * not implement. We replace the select components with a native <select> so
 * tests can interact with the entity-type dropdown without crashing.
 *
 * Coverage:
 * - Initial rendering (entity selector visible, builder hidden before entity chosen)
 * - Entity type selection reveals field checkboxes and clause controls
 * - WHERE clause add / remove
 * - ORDER BY add / remove
 * - "Run query" button triggers API call with correct payload shape
 * - Results table renders column headers and rows
 * - Export CSV button is present after a successful query
 * - Error state renders when API returns an error
 * - Limit input is present with a default of 100
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiClientContext } from "@/lib/api-client.js";
import type { ApiClient } from "@/lib/api-client.js";
import { QueryBuilderPage } from "@/pages/ontology/QueryBuilderPage.js";

// ---------------------------------------------------------------------------
// Router stub — replace TanStack Router so Link / useNavigate work in jsdom
// ---------------------------------------------------------------------------

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    useParams: () => ({}),
    // Render Link as a plain anchor so PageHeader breadcrumbs don't crash
    Link: ({ children, to, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { to?: string; children?: React.ReactNode }) =>
      React.createElement("a", { href: to ?? "#", ...rest }, children),
  };
});

// ---------------------------------------------------------------------------
// Radix Select stub — jsdom lacks hasPointerCapture; replace with native <select>
// The stub mirrors the Radix API surface that QueryBuilderPage.tsx uses:
// Select, SelectTrigger, SelectContent, SelectItem, SelectValue.
// ---------------------------------------------------------------------------

vi.mock("@/components/ui/select.js", () => {
  // We track the current value via a module-level ref so SelectItem can
  // call the onValueChange when the native <option> is selected.
  type SelectContextType = { value: string; onValueChange: (v: string) => void };
  const SelectContext = React.createContext<SelectContextType>({ value: "", onValueChange: () => {} });

  const Select = ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (v: string) => void;
    children?: React.ReactNode;
  }) => (
    <SelectContext.Provider value={{ value: value ?? "", onValueChange: onValueChange ?? (() => {}) }}>
      <div data-testid="select-root">{children}</div>
    </SelectContext.Provider>
  );

  // SelectTrigger renders a visible button label (SelectValue lives inside it)
  const SelectTrigger = ({
    children,
    "aria-label": ariaLabel,
  }: {
    children?: React.ReactNode;
    "aria-label"?: string;
    className?: string;
  }) => {
    const ctx = React.useContext(SelectContext);
    return (
      <div aria-label={ariaLabel} data-value={ctx.value}>
        {children}
      </div>
    );
  };

  const SelectValue = ({ placeholder }: { placeholder?: string }) => {
    const ctx = React.useContext(SelectContext);
    return <span>{ctx.value || placeholder || ""}</span>;
  };

  // SelectContent renders children wrapped in a native <select> so userEvent
  // can pick an option without needing Radix pointer-capture.
  const SelectContent = ({ children }: { children?: React.ReactNode }) => {
    const ctx = React.useContext(SelectContext);
    return (
      <select
        data-testid="select-content"
        value={ctx.value}
        onChange={(e) => ctx.onValueChange(e.target.value)}
        aria-label="select"
      >
        {children}
      </select>
    );
  };

  const SelectItem = ({
    value,
    children,
  }: {
    value: string;
    children?: React.ReactNode;
  }) => <option value={value}>{children}</option>;

  const SelectGroup = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  const SelectSeparator = () => null;
  const SelectLabel = ({ children }: { children?: React.ReactNode }) => <>{children}</>;

  return {
    Select,
    SelectTrigger,
    SelectContent,
    SelectItem,
    SelectValue,
    SelectGroup,
    SelectSeparator,
    SelectLabel,
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ENTITY_LIST_RESPONSE = {
  data: {
    items: [
      { id: "e1", name: "Order", slug: "order", fieldCount: 2 },
      { id: "e2", name: "Customer", slug: "customer", fieldCount: 3 },
    ],
    nextCursor: null,
    total: 2,
    hasMore: false,
  },
};

const ENTITY_DETAIL_RESPONSE = {
  data: {
    id: "e1",
    name: "Order",
    slug: "order",
    version: 1,
    fields: [
      { slug: "status", name: "Status", fieldType: "string" },
      { slug: "amount", name: "Amount", fieldType: "number" },
    ],
    relationships: [],
  },
};

const QUERY_RESULT_RESPONSE = {
  data: {
    columns: [
      { name: "_id", type: "string" },
      { name: "status", type: "string" },
    ],
    rows: [
      { _id: "row-1", status: "active" },
      { _id: "row-2", status: "pending" },
    ],
    totalCount: 2,
    executionTimeMs: 42,
  },
};

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function makeApiClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    get: vi.fn().mockImplementation((path: string) => {
      if (path === "/v1/ontology") return Promise.resolve(ENTITY_LIST_RESPONSE);
      if (path.startsWith("/v1/ontology/")) return Promise.resolve(ENTITY_DETAIL_RESPONSE);
      return Promise.reject(new Error(`Unexpected GET: ${path}`));
    }),
    post: vi.fn().mockResolvedValue(QUERY_RESULT_RESPONSE),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    ...overrides,
  };
}

function renderPage(apiClient: ApiClient = makeApiClient()) {
  const queryClient = createQueryClient();
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <ApiClientContext.Provider value={apiClient}>
          <QueryBuilderPage />
        </ApiClientContext.Provider>
      </QueryClientProvider>,
    ),
    apiClient,
    queryClient,
  };
}

/**
 * Select an entity type via the stubbed native <select>.
 * Waits for the entity list to load first.
 */
async function selectEntityType(user: ReturnType<typeof userEvent.setup>, entitySlug: string) {
  // Wait for entity list to load — the SelectContent/native select appears once data arrives
  const selects = await screen.findAllByTestId("select-content");
  // First select is the entity type selector
  const entitySelect = selects[0]!;
  await user.selectOptions(entitySelect, entitySlug);
}

// ---------------------------------------------------------------------------
// Tests — initial render
// ---------------------------------------------------------------------------

describe("QueryBuilderPage — initial render", () => {
  it("renders the page heading", () => {
    renderPage();
    // The h1 is the most specific element with this text
    expect(screen.getByRole("heading", { name: "Query Builder", level: 1 })).toBeInTheDocument();
  });

  it("renders the entity type selector section", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByText(/entity type/i)).toBeInTheDocument();
    });
  });

  it("does not render field checkboxes before an entity is selected", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.queryByText(/columns to select/i)).not.toBeInTheDocument();
    });
  });

  it("does not render the Run query button before an entity is selected", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /run query/i })).not.toBeInTheDocument();
    });
  });

  it("loads entity list from the API on mount", async () => {
    const apiClient = makeApiClient();
    renderPage(apiClient);
    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledWith("/v1/ontology");
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — entity selection
// ---------------------------------------------------------------------------

describe("QueryBuilderPage — entity selection", () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    user = userEvent.setup();
  });

  it("shows entity options after the list loads", async () => {
    renderPage();
    // Both entities should appear as options in the stub <select>
    expect(await screen.findByRole("option", { name: "Order" })).toBeInTheDocument();
    expect(await screen.findByRole("option", { name: "Customer" })).toBeInTheDocument();
  });

  it("fetches entity detail after selecting an entity", async () => {
    const apiClient = makeApiClient();
    renderPage(apiClient);
    await selectEntityType(user, "order");

    await waitFor(() => {
      expect(apiClient.get).toHaveBeenCalledWith(
        expect.stringContaining("/v1/ontology/order"),
      );
    });
  });

  it("shows field checkboxes after entity is selected", async () => {
    renderPage();
    await selectEntityType(user, "order");

    await waitFor(() => {
      expect(screen.getByText(/columns to select/i)).toBeInTheDocument();
    });
    // User-defined fields should appear as checkbox labels
    expect(await screen.findByText("Status")).toBeInTheDocument();
    expect(await screen.findByText("Amount")).toBeInTheDocument();
  });

  it("shows the Run query button after entity is selected", async () => {
    renderPage();
    await selectEntityType(user, "order");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /run query/i })).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — WHERE clause builder
// ---------------------------------------------------------------------------

describe("QueryBuilderPage — WHERE clause builder", () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    user = userEvent.setup();
  });

  async function selectOrder() {
    await selectEntityType(user, "order");
    await screen.findByText(/columns to select/i);
  }

  it("renders 'Add filter' button after entity selection", async () => {
    renderPage();
    await selectOrder();
    expect(await screen.findByRole("button", { name: /add filter/i })).toBeInTheDocument();
  });

  it("adds a WHERE clause row when 'Add filter' is clicked", async () => {
    renderPage();
    await selectOrder();

    const addBtn = await screen.findByRole("button", { name: /add filter/i });
    await user.click(addBtn);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /remove condition/i })).toBeInTheDocument();
    });
  });

  it("removes a WHERE clause when the remove button is clicked", async () => {
    renderPage();
    await selectOrder();

    const addBtn = await screen.findByRole("button", { name: /add filter/i });
    await user.click(addBtn);

    const removeBtn = await screen.findByRole("button", { name: /remove condition/i });
    await user.click(removeBtn);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /remove condition/i })).not.toBeInTheDocument();
    });
  });

  it("allows adding multiple WHERE clauses", async () => {
    renderPage();
    await selectOrder();

    const addBtn = await screen.findByRole("button", { name: /add filter/i });
    await user.click(addBtn);
    await user.click(addBtn);

    await waitFor(() => {
      const removeBtns = screen.getAllByRole("button", { name: /remove condition/i });
      expect(removeBtns).toHaveLength(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — ORDER BY builder
// ---------------------------------------------------------------------------

describe("QueryBuilderPage — ORDER BY builder", () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    user = userEvent.setup();
  });

  async function selectOrder() {
    await selectEntityType(user, "order");
    await screen.findByText(/columns to select/i);
  }

  it("renders 'Add sort' button after entity selection", async () => {
    renderPage();
    await selectOrder();
    expect(await screen.findByRole("button", { name: /add sort/i })).toBeInTheDocument();
  });

  it("adds an ORDER BY row when 'Add sort' is clicked", async () => {
    renderPage();
    await selectOrder();

    const addBtn = await screen.findByRole("button", { name: /add sort/i });
    await user.click(addBtn);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /remove order/i })).toBeInTheDocument();
    });
  });

  it("removes an ORDER BY row when the remove button is clicked", async () => {
    renderPage();
    await selectOrder();

    const addBtn = await screen.findByRole("button", { name: /add sort/i });
    await user.click(addBtn);

    const removeBtn = await screen.findByRole("button", { name: /remove order/i });
    await user.click(removeBtn);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /remove order/i })).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — Run query
// ---------------------------------------------------------------------------

describe("QueryBuilderPage — Run query", () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    user = userEvent.setup();
  });

  async function selectEntityAndRun(apiClient: ApiClient) {
    renderPage(apiClient);
    await selectEntityType(user, "order");
    await screen.findByText(/columns to select/i);
    const runBtn = await screen.findByRole("button", { name: /run query/i });
    await user.click(runBtn);
  }

  it("calls POST /v1/ontology/query when Run query is clicked", async () => {
    const apiClient = makeApiClient();
    await selectEntityAndRun(apiClient);

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith(
        "/v1/ontology/query",
        expect.objectContaining({ entityType: "order" }),
      );
    });
  });

  it("sends select: ['*'] when no fields are explicitly checked", async () => {
    const apiClient = makeApiClient();
    await selectEntityAndRun(apiClient);

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith(
        "/v1/ontology/query",
        expect.objectContaining({ select: ["*"] }),
      );
    });
  });

  it("renders the Results section after a successful query", async () => {
    const apiClient = makeApiClient();
    await selectEntityAndRun(apiClient);
    expect(await screen.findByText("Results")).toBeInTheDocument();
  });

  it("renders column headers in the results table", async () => {
    const apiClient = makeApiClient();
    await selectEntityAndRun(apiClient);

    await waitFor(() => {
      expect(screen.getByText("_id")).toBeInTheDocument();
      expect(screen.getByText("status")).toBeInTheDocument();
    });
  });

  it("renders row data in the results table", async () => {
    const apiClient = makeApiClient();
    await selectEntityAndRun(apiClient);

    await waitFor(() => {
      expect(screen.getByText("row-1")).toBeInTheDocument();
      expect(screen.getByText("active")).toBeInTheDocument();
    });
  });

  it("shows execution time in the results stats bar", async () => {
    const apiClient = makeApiClient();
    await selectEntityAndRun(apiClient);

    await waitFor(() => {
      expect(screen.getByText(/42ms/)).toBeInTheDocument();
    });
  });

  it("shows total row count in the results stats bar", async () => {
    const apiClient = makeApiClient();
    await selectEntityAndRun(apiClient);

    await waitFor(() => {
      expect(screen.getByText(/2 rows/)).toBeInTheDocument();
    });
  });

  it("shows Export CSV button after successful query", async () => {
    const apiClient = makeApiClient();
    await selectEntityAndRun(apiClient);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /export csv/i })).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — error state
// ---------------------------------------------------------------------------

describe("QueryBuilderPage — error state", () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    user = userEvent.setup();
  });

  it("shows an error alert when the query API returns an error", async () => {
    const apiClient = makeApiClient({
      post: vi.fn().mockRejectedValue(new Error("Server error")),
    });

    renderPage(apiClient);
    await selectEntityType(user, "order");
    await screen.findByText(/columns to select/i);

    const runBtn = await screen.findByRole("button", { name: /run query/i });
    await user.click(runBtn);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — limit input
// ---------------------------------------------------------------------------

describe("QueryBuilderPage — limit control", () => {
  let user: ReturnType<typeof userEvent.setup>;

  beforeEach(() => {
    user = userEvent.setup();
  });

  it("renders a limit input with default value 100 after entity selection", async () => {
    renderPage();
    await selectEntityType(user, "order");
    await screen.findByText(/columns to select/i);

    await waitFor(() => {
      const input = screen.getByRole("spinbutton");
      expect(input).toHaveValue(100);
    });
  });

  it("passes the configured limit to the query API", async () => {
    const apiClient = makeApiClient();
    renderPage(apiClient);
    await selectEntityType(user, "order");
    await screen.findByText(/columns to select/i);

    // Change limit to 50
    const limitInput = await screen.findByRole("spinbutton");
    await user.clear(limitInput);
    await user.type(limitInput, "50");

    const runBtn = await screen.findByRole("button", { name: /run query/i });
    await user.click(runBtn);

    await waitFor(() => {
      expect(apiClient.post).toHaveBeenCalledWith(
        "/v1/ontology/query",
        expect.objectContaining({ limit: 50 }),
      );
    });
  });
});
