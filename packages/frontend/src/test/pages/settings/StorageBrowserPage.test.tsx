/**
 * StorageBrowserPage tests.
 *
 * Verifies:
 *   - Bucket list renders when API returns buckets.
 *   - Loading skeleton is shown while fetching buckets.
 *   - Empty state renders when there are no buckets.
 *   - Clicking a bucket enters the object browser for that bucket.
 *   - Object list renders files and folders.
 *   - Empty state renders when the prefix has no objects.
 *   - Client-side search filters objects by name.
 *   - Folder click navigates into the folder (updates breadcrumb).
 *   - "All buckets" button returns to the bucket list.
 *   - Delete button opens the confirm dialog; confirming calls the API.
 *   - Error state renders when the API fails.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, createMockApiClient } from "@/test/test-utils.js";
import { StorageBrowserPage } from "@/pages/settings/StorageBrowserPage.js";
import { ApiError } from "@/lib/api-client.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * StorageBrowserPage uses RelativeTime which renders a Tooltip — Tooltip
 * requires TooltipProvider to be in the tree. Wrap the page here so tests
 * don't need to replicate the AppShell provider chain.
 */
function WrappedStorageBrowserPage() {
  return (
    <TooltipProvider>
      <StorageBrowserPage />
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_BUCKETS = {
  data: [
    { name: "file-uploads", createdAt: "2024-01-15T10:00:00.000Z" },
    { name: "datasets", createdAt: "2024-02-20T08:30:00.000Z" },
  ],
};

const MOCK_OBJECTS = {
  data: {
    objects: [
      {
        key: "report.csv",
        size: 2048,
        lastModified: "2024-03-01T12:00:00.000Z",
        contentType: null,
        etag: "abc123",
        isFolder: false,
      },
      {
        key: "data.json",
        size: 512,
        lastModified: "2024-03-05T09:00:00.000Z",
        contentType: null,
        etag: "def456",
        isFolder: false,
      },
      {
        key: "logs/",
        size: null,
        lastModified: null,
        contentType: null,
        etag: null,
        isFolder: true,
      },
    ],
    nextContinuationToken: null,
    isTruncated: false,
  },
};

const EMPTY_OBJECTS = {
  data: {
    objects: [],
    nextContinuationToken: null,
    isTruncated: false,
  },
};

// ---------------------------------------------------------------------------
// Suite: bucket list view
// ---------------------------------------------------------------------------

describe("StorageBrowserPage — bucket list", () => {
  let mockClient: ReturnType<typeof createMockApiClient>;

  beforeEach(() => {
    mockClient = createMockApiClient();
  });

  it("renders the page heading", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_BUCKETS);
    renderWithProviders(<WrappedStorageBrowserPage />, { apiClient: mockClient });

    expect(screen.getByText("Storage Browser")).toBeInTheDocument();
  });

  it("shows buckets after loading", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValue(MOCK_BUCKETS);
    renderWithProviders(<WrappedStorageBrowserPage />, { apiClient: mockClient });

    await waitFor(() => {
      expect(screen.getByText("file-uploads")).toBeInTheDocument();
      expect(screen.getByText("datasets")).toBeInTheDocument();
    });
  });

  it("shows a loading skeleton while fetching", () => {
    // Never resolves — stays in loading state.
    (mockClient.get as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}));
    renderWithProviders(<WrappedStorageBrowserPage />, { apiClient: mockClient });

    // Skeletons render as pulsing div elements during loading.
    const skeletons = document.querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBeGreaterThan(0);
  });

  it("shows empty state when no buckets exist", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [] });
    renderWithProviders(<WrappedStorageBrowserPage />, { apiClient: mockClient });

    await waitFor(() => {
      expect(screen.getByText("No buckets found")).toBeInTheDocument();
    });
  });

  it("shows an error message when the API fails", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiError(503, "SERVICE_UNAVAILABLE", "MinIO unreachable", "req-1"),
    );
    renderWithProviders(<WrappedStorageBrowserPage />, { apiClient: mockClient });

    await waitFor(() => {
      expect(screen.getByText(/Failed to load buckets/i)).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Suite: object browser view (after selecting a bucket)
// ---------------------------------------------------------------------------

describe("StorageBrowserPage — object browser", () => {
  let mockClient: ReturnType<typeof createMockApiClient>;
  const user = userEvent.setup();

  beforeEach(() => {
    mockClient = createMockApiClient();
    (mockClient.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      if (path.includes("/storage/buckets") && !path.includes("/objects")) {
        // Bucket list call — only if path ends at /buckets exactly.
        if (path === "/v1/storage/buckets") {
          return Promise.resolve(MOCK_BUCKETS);
        }
      }
      if (path.includes("/objects")) {
        return Promise.resolve(MOCK_OBJECTS);
      }
      return Promise.resolve(MOCK_BUCKETS);
    });
  });

  async function selectBucket(name = "file-uploads"): Promise<void> {
    await waitFor(() => expect(screen.getByText(name)).toBeInTheDocument());
    await user.click(screen.getByText(name));
  }

  it("renders object list after selecting a bucket", async () => {
    renderWithProviders(<WrappedStorageBrowserPage />, { apiClient: mockClient });
    await selectBucket();

    await waitFor(() => {
      expect(screen.getByText("report.csv")).toBeInTheDocument();
      expect(screen.getByText("data.json")).toBeInTheDocument();
    });
  });

  it("renders folder entries as clickable buttons", async () => {
    renderWithProviders(<WrappedStorageBrowserPage />, { apiClient: mockClient });
    await selectBucket();

    await waitFor(() => expect(screen.getByText("logs")).toBeInTheDocument());
    const folderButton = screen.getByRole("button", { name: "logs" });
    expect(folderButton).toBeInTheDocument();
  });

  it("shows human-readable file sizes", async () => {
    renderWithProviders(<WrappedStorageBrowserPage />, { apiClient: mockClient });
    await selectBucket();

    await waitFor(() => {
      // 2048 bytes → "2.0 KB"
      expect(screen.getByText("2.0 KB")).toBeInTheDocument();
    });
  });

  it("shows an empty state when no objects exist at the prefix", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      if (path === "/v1/storage/buckets") return Promise.resolve(MOCK_BUCKETS);
      if (path.includes("/objects")) return Promise.resolve(EMPTY_OBJECTS);
      return Promise.resolve(MOCK_BUCKETS);
    });

    renderWithProviders(<WrappedStorageBrowserPage />, { apiClient: mockClient });
    await selectBucket();

    await waitFor(() => {
      expect(screen.getByText("This location is empty")).toBeInTheDocument();
    });
  });

  it("shows error state when object listing fails", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      if (path === "/v1/storage/buckets") return Promise.resolve(MOCK_BUCKETS);
      return Promise.reject(new ApiError(403, "FORBIDDEN", "Access denied", "req-1"));
    });

    renderWithProviders(<WrappedStorageBrowserPage />, { apiClient: mockClient });
    await selectBucket();

    await waitFor(() => {
      expect(screen.getByText(/Failed to list objects/i)).toBeInTheDocument();
    });
  });

  it("filters objects by name when search query is entered", async () => {
    renderWithProviders(<WrappedStorageBrowserPage />, { apiClient: mockClient });
    await selectBucket();

    await waitFor(() => expect(screen.getByText("report.csv")).toBeInTheDocument());

    const searchInput = screen.getByPlaceholderText("Filter by filename...");
    await user.type(searchInput, "report");

    // data.json should be hidden; report.csv should remain visible.
    expect(screen.getByText("report.csv")).toBeInTheDocument();
    expect(screen.queryByText("data.json")).not.toBeInTheDocument();
  });

  it("shows empty search state when no objects match the filter (no folders)", async () => {
    // Override to return only files (no folders) so the empty state is reachable.
    (mockClient.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      if (path === "/v1/storage/buckets") return Promise.resolve(MOCK_BUCKETS);
      return Promise.resolve({
        data: {
          objects: [
            { key: "report.csv", size: 2048, lastModified: "2024-03-01T12:00:00.000Z", contentType: null, etag: "abc", isFolder: false },
          ],
          nextContinuationToken: null,
          isTruncated: false,
        },
      });
    });

    renderWithProviders(<WrappedStorageBrowserPage />, { apiClient: mockClient });
    await selectBucket();

    await waitFor(() => expect(screen.getByText("report.csv")).toBeInTheDocument());

    const searchInput = screen.getByPlaceholderText("Filter by filename...");
    await user.type(searchInput, "xyzzy-no-match");

    await waitFor(() => {
      expect(screen.getByText("No objects match")).toBeInTheDocument();
    });
  });

  it("updates breadcrumb when navigating into a folder", async () => {
    (mockClient.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      if (path === "/v1/storage/buckets") return Promise.resolve(MOCK_BUCKETS);
      return Promise.resolve(MOCK_OBJECTS);
    });

    renderWithProviders(<WrappedStorageBrowserPage />, { apiClient: mockClient });
    await selectBucket();

    await waitFor(() => expect(screen.getByText("logs")).toBeInTheDocument());

    const folderButton = screen.getByRole("button", { name: "logs" });
    await user.click(folderButton);

    // "logs" should now appear as the active breadcrumb segment.
    await waitFor(() => {
      const logsHeading = screen.getByText("logs", { selector: "span" });
      expect(logsHeading).toBeInTheDocument();
    });
  });

  it("navigates back to bucket list when 'All buckets' is clicked", async () => {
    renderWithProviders(<WrappedStorageBrowserPage />, { apiClient: mockClient });
    await selectBucket();

    await waitFor(() => expect(screen.getByText("report.csv")).toBeInTheDocument());

    const backButton = screen.getByRole("button", { name: /all buckets/i });
    await user.click(backButton);

    await waitFor(() => {
      expect(screen.getByText("Storage Browser")).toBeInTheDocument();
      expect(screen.queryByText("report.csv")).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Suite: delete flow
// ---------------------------------------------------------------------------

describe("StorageBrowserPage — delete", () => {
  let mockClient: ReturnType<typeof createMockApiClient>;
  const user = userEvent.setup();

  beforeEach(() => {
    mockClient = createMockApiClient();
    (mockClient.get as ReturnType<typeof vi.fn>).mockImplementation((path: string) => {
      if (path === "/v1/storage/buckets") return Promise.resolve(MOCK_BUCKETS);
      return Promise.resolve(MOCK_OBJECTS);
    });
    (mockClient.delete as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { deleted: true, key: "report.csv" } });
  });

  async function openBucket(): Promise<void> {
    await waitFor(() => expect(screen.getByText("file-uploads")).toBeInTheDocument());
    await user.click(screen.getByText("file-uploads"));
    await waitFor(() => expect(screen.getByText("report.csv")).toBeInTheDocument());
  }

  it("opens confirm dialog when delete button is clicked", async () => {
    renderWithProviders(<WrappedStorageBrowserPage />, { apiClient: mockClient });
    await openBucket();

    const deleteButton = screen.getByRole("button", { name: 'Delete "report.csv"' });
    await user.click(deleteButton);

    // Dialog title is rendered in an <h2>; use heading role to distinguish from
    // the confirm button which also contains "Delete object".
    expect(screen.getByRole("heading", { name: "Delete object" })).toBeInTheDocument();
    expect(screen.getByText(/Permanently delete/i)).toBeInTheDocument();
  });

  it("calls the delete API when the confirm button is clicked", async () => {
    renderWithProviders(<WrappedStorageBrowserPage />, { apiClient: mockClient });
    await openBucket();

    await user.click(screen.getByRole("button", { name: 'Delete "report.csv"' }));
    await user.click(screen.getByRole("button", { name: "Delete object" }));

    await waitFor(() => {
      expect(mockClient.delete).toHaveBeenCalledWith(
        expect.stringContaining("report.csv"),
      );
    });
  });

  it("dismisses the confirm dialog when cancel is clicked", async () => {
    renderWithProviders(<WrappedStorageBrowserPage />, { apiClient: mockClient });
    await openBucket();

    await user.click(screen.getByRole("button", { name: 'Delete "report.csv"' }));
    expect(screen.getByRole("heading", { name: "Delete object" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Delete object" })).not.toBeInTheDocument();
    });
    expect(mockClient.delete).not.toHaveBeenCalled();
  });
});
