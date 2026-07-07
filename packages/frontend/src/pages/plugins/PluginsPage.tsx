/**
 * PluginsPage — plugin grid with type filter tabs and install button.
 *
 * Route: /plugins
 *
 * Tabs: all / connector / transformer / destination / auth-provider / widget.
 * Install button requires plugins:manage scope.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Package } from "lucide-react";

// Cast Lucide icons to avoid exactOptionalPropertyTypes conflict on className
type IconComponent = React.ComponentType<{ className?: string }>;
const PackageIcon = Package as IconComponent;
import { Button } from "@/components/ui/button.js";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { EmptyState } from "@/components/shared/EmptyState.js";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { PluginCard, type PluginCardData, type PluginType } from "@/components/plugins/PluginCard.js";
import { PluginInstallDialog } from "@/components/plugins/PluginInstallDialog.js";
import { useApiClient } from "@/lib/api-client.js";
import { useScope } from "@/hooks/use-auth.js";


const ALL_TYPES: Array<PluginType | "all"> = [
  "all",
  "connector",
  "transformer",
  "destination",
  "auth-provider",
  "widget",
];

const TYPE_LABELS: Record<PluginType | "all", string> = {
  all: "All",
  connector: "Connectors",
  transformer: "Transformers",
  destination: "Destinations",
  "auth-provider": "Auth",
  widget: "Widgets",
};

export function PluginsPage() {
  const client = useApiClient();
  const navigate = useNavigate();
  const canInstall = useScope("plugins:manage");

  const [typeFilter, setTypeFilter] = React.useState<PluginType | "all">("all");
  const [installOpen, setInstallOpen] = React.useState(false);

  const query = useQuery({
    queryKey: ["plugins"],
    queryFn: ({ signal }) =>
      client.get<{ items: PluginCardData[]; nextCursor: string | null; total: number }>("/v1/plugins", undefined, { signal }),
  });

  const plugins = query.data?.items ?? [];

  const filtered = React.useMemo(() => {
    if (typeFilter === "all") return plugins;
    return plugins.filter((p) => p.type === typeFilter);
  }, [plugins, typeFilter]);

  return (
    <div className="flex-1 p-6">
      <PageHeader
        title="Plugins"
        description="Extend OnePlatform with connectors, transformers, and auth providers."
        actions={
          canInstall ? (
            <Button onClick={() => setInstallOpen(true)}>
              Install Plugin
            </Button>
          ) : undefined
        }
      />

      <Tabs
        value={typeFilter}
        onValueChange={(v) => setTypeFilter(v as PluginType | "all")}
        className="mt-6"
      >
        <TabsList>
          {ALL_TYPES.map((type) => (
            <TabsTrigger key={type} value={type}>
              {TYPE_LABELS[type]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="mt-4">
        {query.isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-32 w-full rounded-lg" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={PackageIcon}
            title={plugins.length === 0 ? "No plugins installed" : "No plugins in this category"}
            {...(plugins.length === 0 && canInstall ? {
              description: "Install your first plugin to extend the platform.",
              actionLabel: "Install Plugin",
              onAction: () => setInstallOpen(true),
            } : {})}
          />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {filtered.map((plugin) => (
              <PluginCard
                key={plugin.id}
                plugin={plugin}
                onClick={(id) => void navigate({ to: "/plugins/$id", params: { id } })}
              />
            ))}
          </div>
        )}
      </div>

      <PluginInstallDialog
        open={installOpen}
        onOpenChange={setInstallOpen}
        onInstalled={(id) => void navigate({ to: "/plugins/$id", params: { id } })}
      />
    </div>
  );
}
