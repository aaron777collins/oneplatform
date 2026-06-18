/**
 * Dashboard App — Product Catalog
 *
 * Demonstrates the three core @oneplatform/app-sdk patterns:
 *
 *   1. useQuery        — paginated entity fetching with SWR caching
 *   2. usePermission   — synchronous permission-gated UI
 *   3. useSubscription — live entity change events via WebSocket
 *
 * Entry point. The platform's HTML shell bootstraps this component after
 * injecting window.__OP_APP_CONFIG__. AppProvider reads that config,
 * authenticates, and withholds children until ready.
 */

import React from "react";
import {
  AppProvider,
  useQuery,
  usePermission,
  useSubscription,
} from "@oneplatform/app-sdk";
import type {
  QueryOptions,
  EntityEvent,
  SubscriptionOptions,
} from "@oneplatform/app-sdk";

// ---------------------------------------------------------------------------
// Domain type
//
// Matches the `Product` entity fields created in examples/data-pipeline.
// TypeScript enforces that we only access fields we declared here — the
// platform's BFF will pass through additional fields silently.
// ---------------------------------------------------------------------------

interface Product {
  id: string;
  name: string;
  price: number;
  status: "active" | "discontinued" | "draft";
  updatedAt: string | null;
}

// ---------------------------------------------------------------------------
// ProductTable
//
// Renders a list of products with:
//   - Filtered view (active products only)
//   - "Load more" cursor pagination (infinite scroll pattern)
//   - Live indicator that flashes when a new event arrives
//   - Conditionally visible "Edit" button based on the user's permissions
// ---------------------------------------------------------------------------

function ProductTable(): React.JSX.Element {
  // Memoize query options so useQuery's cache key stays stable between renders.
  // Passing an inline object literal here would create a new key on every render,
  // causing redundant network requests — the hook's JSDoc explains this in detail.
  const queryOptions = React.useMemo<QueryOptions>(
    () => ({
      filter: { status: { eq: "active" } },
      sort: ["-updatedAt"],
      limit: 20,
    }),
    // No dependencies: this filter is constant for the lifetime of the component.
    [],
  );

  const { data: products, isLoading, isError, error, fetchNextPage, pagination } =
    useQuery<Product>("Product", queryOptions);

  // usePermission is synchronous — it never causes a loading state because
  // AppProvider seeds the permission cache before rendering children.
  // The platform permission model: "action:resource" — admin:* grants all actions.
  const canEdit = usePermission("update", "Product");

  // Track the most recent live event so we can highlight the table when
  // something changes, even if the polling cache has not refreshed yet.
  const [recentEvent, setRecentEvent] = React.useState<EntityEvent<Product> | null>(null);

  const subscriptionOptions = React.useMemo<SubscriptionOptions>(
    () => ({
      // Subscribe only to mutations that affect visible rows.
      events: ["created", "updated", "deleted"],
      onEvent: (event) => {
        setRecentEvent(event as EntityEvent<Product>);
        // Clear the flash indicator after 3 seconds.
        setTimeout(() => setRecentEvent(null), 3_000);
      },
    }),
    [],
  );

  const { isConnected } = useSubscription<Product>("Product", subscriptionOptions);

  // ── Loading state ──────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div style={styles.centerBox} aria-live="polite" aria-busy="true">
        <p style={styles.mutedText}>Loading products...</p>
      </div>
    );
  }

  // ── Error state ────────────────────────────────────────────────────────────

  if (isError) {
    return (
      <div style={styles.errorBox} role="alert">
        <strong>Failed to load products</strong>
        <p style={{ margin: "0.5rem 0 0", fontSize: "0.875rem" }}>
          {error?.message ?? "An unknown error occurred."}
          {error?.isRetryable && (
            <span style={{ color: "#6b7280" }}> (This error is retryable — the SDK will retry automatically.)</span>
          )}
        </p>
      </div>
    );
  }

  // ── Empty state ────────────────────────────────────────────────────────────

  if (!products || products.length === 0) {
    return (
      <div style={styles.centerBox}>
        <p style={styles.mutedText}>
          No active products found. Run the data pipeline to ingest product data.
        </p>
      </div>
    );
  }

  // ── Table ──────────────────────────────────────────────────────────────────

  return (
    <div>
      {/* Live event flash banner — shown for 3 seconds after any change event */}
      {recentEvent && (
        <div
          role="status"
          aria-live="polite"
          style={styles.liveBanner}
        >
          Live update: product <strong>{recentEvent.id}</strong> was {recentEvent.type}.
        </div>
      )}

      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Name</th>
            <th style={styles.th}>Price</th>
            <th style={styles.th}>Status</th>
            <th style={styles.th}>Last updated</th>
            {/* Only render the Actions column when the user has edit permission.
                This avoids rendering a disabled button — an empty column is less
                confusing for users who cannot edit. */}
            {canEdit && <th style={styles.th}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {products.map((product) => (
            <tr
              key={product.id}
              style={{
                ...styles.tr,
                // Highlight the row of the most recently changed product
                // so the user's eye is drawn to the change without a full
                // page re-fetch.
                backgroundColor:
                  recentEvent?.id === product.id ? "#fefce8" : undefined,
              }}
            >
              <td style={styles.td}>{product.name}</td>
              <td style={styles.td}>${product.price.toFixed(2)}</td>
              <td style={styles.td}>
                <StatusBadge status={product.status} />
              </td>
              <td style={styles.td}>
                {product.updatedAt
                  ? new Date(product.updatedAt).toLocaleDateString()
                  : "—"}
              </td>
              {canEdit && (
                <td style={styles.td}>
                  {/* Replace with your edit modal or routing logic */}
                  <button
                    type="button"
                    style={styles.editButton}
                    onClick={() => console.log("Edit product", product.id)}
                  >
                    Edit
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      {/* Cursor pagination: fetch and append the next page.
          fetchNextPage is a no-op if pagination.nextCursor is null. */}
      {pagination?.nextCursor && (
        <div style={{ textAlign: "center", marginTop: "1rem" }}>
          <button
            type="button"
            style={styles.loadMoreButton}
            onClick={() => void fetchNextPage()}
          >
            Load more
          </button>
        </div>
      )}

      <div style={styles.footer}>
        {pagination?.total !== undefined && (
          <span>{pagination.total} active products total</span>
        )}
        {/* WebSocket connection indicator — useful during development */}
        <span style={{ marginLeft: "auto", color: isConnected ? "#16a34a" : "#dc2626" }}>
          {isConnected ? "Live" : "Reconnecting..."}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatusBadge — small inline component kept separate to keep ProductTable readable
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: Product["status"] }): React.JSX.Element {
  const colors: Record<Product["status"], { bg: string; fg: string }> = {
    active:       { bg: "#dcfce7", fg: "#166534" },
    discontinued: { bg: "#fee2e2", fg: "#991b1b" },
    draft:        { bg: "#f3f4f6", fg: "#374151" },
  };
  const { bg, fg } = colors[status] ?? colors.draft;

  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 8px",
        borderRadius: "9999px",
        fontSize: "0.75rem",
        fontWeight: 500,
        backgroundColor: bg,
        color: fg,
      }}
    >
      {status}
    </span>
  );
}

// ---------------------------------------------------------------------------
// App root
//
// AppProvider must wrap the entire component tree. It performs three async
// operations at mount (fetching /bff/me, /bff/permissions, and opening the
// WebSocket) and withholds children until all three complete.
// ---------------------------------------------------------------------------

export default function App(): React.JSX.Element {
  return (
    <AppProvider
      loadingFallback={
        <div style={styles.centerBox} aria-live="polite" aria-busy="true">
          <p style={styles.mutedText}>Loading application...</p>
        </div>
      }
    >
      <div style={styles.page}>
        <header style={styles.header}>
          <h1 style={styles.heading}>Product Catalog</h1>
        </header>
        <main style={styles.main}>
          <ProductTable />
        </main>
      </div>
    </AppProvider>
  );
}

// ---------------------------------------------------------------------------
// Inline styles — kept minimal to avoid a CSS bundler dependency in this example.
// Replace with Tailwind or your CSS solution in a real app.
// ---------------------------------------------------------------------------

const styles = {
  page: {
    fontFamily: "system-ui, -apple-system, sans-serif",
    minHeight: "100dvh",
    backgroundColor: "#f9fafb",
  },
  header: {
    backgroundColor: "#ffffff",
    borderBottom: "1px solid #e5e7eb",
    padding: "1rem 2rem",
  },
  heading: {
    margin: 0,
    fontSize: "1.25rem",
    fontWeight: 600,
    color: "#111827",
  },
  main: {
    padding: "2rem",
    maxWidth: "1200px",
    margin: "0 auto",
  },
  centerBox: {
    display: "flex",
    justifyContent: "center",
    padding: "4rem 2rem",
  },
  errorBox: {
    padding: "1rem",
    borderRadius: "8px",
    backgroundColor: "#fef2f2",
    border: "1px solid #fca5a5",
    color: "#991b1b",
  },
  mutedText: {
    color: "#6b7280",
    fontSize: "0.875rem",
  },
  liveBanner: {
    marginBottom: "1rem",
    padding: "0.5rem 1rem",
    borderRadius: "6px",
    backgroundColor: "#fefce8",
    border: "1px solid #fde047",
    fontSize: "0.875rem",
    color: "#713f12",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    backgroundColor: "#ffffff",
    borderRadius: "8px",
    overflow: "hidden",
    border: "1px solid #e5e7eb",
  },
  th: {
    padding: "0.75rem 1rem",
    textAlign: "left" as const,
    fontSize: "0.75rem",
    fontWeight: 600,
    color: "#6b7280",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    backgroundColor: "#f9fafb",
    borderBottom: "1px solid #e5e7eb",
  },
  tr: {
    borderBottom: "1px solid #f3f4f6",
    transition: "background-color 0.3s",
  },
  td: {
    padding: "0.875rem 1rem",
    fontSize: "0.875rem",
    color: "#374151",
  },
  editButton: {
    padding: "0.25rem 0.75rem",
    borderRadius: "4px",
    border: "1px solid #d1d5db",
    backgroundColor: "#ffffff",
    fontSize: "0.75rem",
    cursor: "pointer",
    color: "#374151",
  },
  loadMoreButton: {
    padding: "0.5rem 1.5rem",
    borderRadius: "6px",
    border: "1px solid #d1d5db",
    backgroundColor: "#ffffff",
    fontSize: "0.875rem",
    cursor: "pointer",
    color: "#374151",
    fontWeight: 500,
  },
  footer: {
    display: "flex",
    alignItems: "center",
    marginTop: "0.75rem",
    padding: "0 0.25rem",
    fontSize: "0.8125rem",
    color: "#9ca3af",
  },
} as const;
