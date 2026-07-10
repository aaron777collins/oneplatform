/**
 * ConnectorMarketplacePage — searchable catalog of available connector types.
 *
 * Route: /connectors/marketplace
 *
 * Features:
 * - Card grid of all available connectors (built-ins always first)
 * - Full-text search (name, description, tags)
 * - Category filter tabs
 * - Sort by: popular, recent, name
 * - Clicking a card opens ConnectorDetailSheet for full details + install button
 * - "Installed" badge on cards where the tenant already has this connector type
 * - One-click install (POST /api/v1/connector-registry/:type/install) then
 *   navigates to /connectors/new with the type pre-filled
 */
import * as React from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Search, SlidersHorizontal, Store } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { EmptyState } from "@/components/shared/EmptyState.js";
import { PageHeader } from "@/components/layout/PageHeader.js";
import {
  ConnectorMarketplaceCard,
  type ConnectorMarketplaceCardData,
  type ConnectorCategory,
} from "@/components/connectors/ConnectorMarketplaceCard.js";
import { ConnectorDetailSheet } from "@/components/connectors/ConnectorDetailSheet.js";
import { useApiClient, type ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

interface RegistryListResult {
  items: ConnectorMarketplaceCardData[];
  nextCursor: string | null;
  total: number;
}

interface ConnectorApiRecord {
  connector: {
    id: string;
    plugin_id: string;
  };
  syncState: unknown;
}

interface InstalledConnectorsResult {
  items: ConnectorApiRecord[];
  data: ConnectorApiRecord[];
  nextCursor: string | null;
  total: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALL_CATEGORIES: Array<ConnectorCategory | "all"> = [
  "all",
  "database",
  "api",
  "file",
  "streaming",
  "webhook",
  "custom",
];

const CATEGORY_LABELS: Record<ConnectorCategory | "all", string> = {
  all: "All",
  database: "Database",
  api: "API",
  file: "File",
  streaming: "Streaming",
  webhook: "Webhook",
  custom: "Custom",
};

// ---------------------------------------------------------------------------
// ConnectorMarketplacePage component
// ---------------------------------------------------------------------------

export function ConnectorMarketplacePage() {
  const client = useApiClient();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [search, setSearch] = React.useState("");
  const [category, setCategory] = React.useState<ConnectorCategory | "all">("all");
  const [sortBy, setSortBy] = React.useState<"popular" | "recent" | "name">("popular");
  const [selectedType, setSelectedType] = React.useState<string | null>(null);

  // Debounce the search string so we don't fire a query on every keystroke.
  const [debouncedSearch, setDebouncedSearch] = React.useState("");
  React.useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  // Build the query params object only when values are non-default to keep
  // the URL and cache key readable.
  const queryParams: Record<string, string> = { sortBy, limit: "100" };
  if (debouncedSearch.trim() !== "") queryParams["search"] = debouncedSearch.trim();
  if (category !== "all") queryParams["category"] = category;

  const registryQuery = useQuery({
    queryKey: ["connector-registry", queryParams],
    queryFn: ({ signal }) =>
      client.get<RegistryListResult>("/v1/connector-registry", queryParams, { signal }),
    staleTime: 60_000, // catalog is stable — re-fetch every minute at most
  });

  // Fetch the tenant's existing connectors so we can mark installed types.
  const installedQuery = useQuery({
    queryKey: ["connectors"],
    queryFn: ({ signal }) =>
      client.get<InstalledConnectorsResult>("/v1/connectors", undefined, { signal }),
  });

  // Build a set of plugin_id values (connector types) already in this tenant.
  // The response may be envelope-wrapped: { data: { items: [...], data: [...], ... } }
  const installedTypes = React.useMemo<ReadonlySet<string>>(() => {
    const raw = installedQuery.data;
    const inner = raw?.data;
    const records: ConnectorApiRecord[] = Array.isArray(inner)
      ? inner
      : (inner as unknown as { items?: ConnectorApiRecord[] })?.items ?? [];
    return new Set(records.map((r) => r.connector.plugin_id));
  }, [installedQuery.data]);

  // One-click install: POST to registry to record the install event, then
  // navigate to the new-connector wizard with type pre-filled.
  const installMutation = useMutation({
    mutationFn: async (connectorType: string) => {
      await client.post<unknown>(
        `/v1/connector-registry/${encodeURIComponent(connectorType)}/install`,
      );
      return connectorType;
    },
    onSuccess: (connectorType: string) => {
      void queryClient.invalidateQueries({ queryKey: ["connector-registry"] });
      toast({
        title: "Connector ready to configure",
        description: "Fill in the connection details to complete setup.",
      });
      // Navigate to the new-connector wizard with the type pre-selected via
      // search params so the form can auto-select the plugin.
      void navigate({
        to: "/connectors/new",
        search: { pluginId: connectorType },
      });
    },
    onError: (error: unknown) => {
      const message =
        (error as ApiError | undefined)?.message ?? "Installation failed. Please try again.";
      toast({ title: "Install failed", description: message, variant: "destructive" });
    },
  });

  const connectors = registryQuery.data?.items ?? [];

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader
        title="Connector Marketplace"
        breadcrumbs={[
          { label: "Platform" },
          { label: "Connectors", href: "/connectors" },
          { label: "Marketplace" },
        ]}
        description="Browse and install connectors to bring data into OnePlatform."
        actions={
          <Button
            variant="outline"
            onClick={() => void navigate({ to: "/connectors" })}
          >
            My Connectors
          </Button>
        }
      />

      <div className="p-6 space-y-4">
        {/* Search + sort bar */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          {/* Search */}
          <div className="relative flex-1 max-w-sm">
            <Search
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted-foreground)]"
              aria-hidden
            />
            <Input
              className="pl-9"
              placeholder="Search connectors…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search connector marketplace"
            />
          </div>

          {/* Sort selector */}
          <div className="flex items-center gap-2">
            <SlidersHorizontal
              className="h-4 w-4 text-[var(--color-muted-foreground)]"
              aria-hidden
            />
            <Select
              value={sortBy}
              onValueChange={(v) => setSortBy(v as "popular" | "recent" | "name")}
            >
              <SelectTrigger className="w-36" aria-label="Sort connectors">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="popular">Most popular</SelectItem>
                <SelectItem value="recent">Most recent</SelectItem>
                <SelectItem value="name">Name A–Z</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Category tabs */}
        <Tabs
          value={category}
          onValueChange={(v) => setCategory(v as ConnectorCategory | "all")}
        >
          <TabsList className="flex-wrap h-auto gap-1">
            {ALL_CATEGORIES.map((cat) => (
              <TabsTrigger key={cat} value={cat}>
                {CATEGORY_LABELS[cat]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {/* Results count */}
        {!registryQuery.isLoading && connectors.length > 0 && (
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {registryQuery.data?.total ?? connectors.length} connector
            {(registryQuery.data?.total ?? connectors.length) !== 1 ? "s" : ""} available
          </p>
        )}

        {/* Grid */}
        {registryQuery.isError ? (
          <EmptyState
            title="Failed to load connector catalog"
            description="Check your connection and try again."
            actionLabel="Retry"
            onAction={() => void registryQuery.refetch()}
          />
        ) : registryQuery.isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                key={i}
                className="space-y-3 rounded-lg border border-[var(--color-border)] p-4"
              >
                <div className="flex items-center gap-3">
                  <Skeleton className="h-10 w-10 rounded-lg" />
                  <div className="space-y-1.5 flex-1">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-8 w-full" />
              </div>
            ))}
          </div>
        ) : connectors.length === 0 ? (
          <EmptyState
            icon={Store as React.ComponentType<{ className?: string }>}
            title="No connectors found"
            description={
              debouncedSearch.trim() !== "" || category !== "all"
                ? "Try adjusting your search or category filter."
                : "The connector catalog is empty."
            }
            {...(debouncedSearch.trim() !== "" || category !== "all"
              ? {
                  actionLabel: "Clear filters",
                  onAction: () => {
                    setSearch("");
                    setCategory("all");
                  },
                }
              : {})}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {connectors.map((connector) => (
              <ConnectorMarketplaceCard
                key={connector.type}
                connector={{
                  ...connector,
                  installed: installedTypes.has(connector.type),
                }}
                onClick={(type) => setSelectedType(type)}
                onInstall={(type) => installMutation.mutate(type)}
                isInstalling={
                  installMutation.isPending &&
                  installMutation.variables === connector.type
                }
              />
            ))}
          </div>
        )}
      </div>

      {/* Detail sheet */}
      <ConnectorDetailSheet
        connectorType={selectedType}
        onOpenChange={(open) => {
          if (!open) setSelectedType(null);
        }}
        onInstall={(type) => {
          installMutation.mutate(type);
          setSelectedType(null);
        }}
        isInstalling={installMutation.isPending}
        installedTypes={installedTypes}
      />
    </div>
  );
}
