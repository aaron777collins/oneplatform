/**
 * ConnectorDetailSheet — slide-in panel showing full connector registry details.
 *
 * Displays the config schema as a readable field list, capabilities flags,
 * version history, and an Install button that fires onInstall.
 *
 * The panel uses a Sheet (side drawer) rather than a full navigation so the
 * user stays on the marketplace page and can dismiss without losing their
 * search/filter state.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  XCircle,
  Database as DatabaseIcon,
  Globe as GlobeIcon,
  FileText as FileTextIcon,
  Zap as ZapIcon,
  Radio as RadioIcon,
  Box as BoxIcon,
} from "lucide-react";

// Cast Lucide icons to satisfy exactOptionalPropertyTypes on className
type IconComponent = React.ComponentType<{ className?: string | undefined }>;
const Database = DatabaseIcon as IconComponent;
const Globe = GlobeIcon as IconComponent;
const FileText = FileTextIcon as IconComponent;
const Zap = ZapIcon as IconComponent;
const Radio = RadioIcon as IconComponent;
const Box = BoxIcon as IconComponent;
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { Separator } from "@/components/ui/separator.js";
import { useApiClient, type ApiError } from "@/lib/api-client.js";
import type { ConnectorCategory } from "./ConnectorMarketplaceCard.js";

// ---------------------------------------------------------------------------
// API types matching the registry service response shapes
// ---------------------------------------------------------------------------

interface ConnectorCapabilities {
  supportsIncremental: boolean;
  supportsRealtime: boolean;
  supportsCdc: boolean;
}

interface ConnectorRegistryEntry {
  type: string;
  displayName: string;
  description: string;
  version: string;
  category: ConnectorCategory;
  author: string;
  icon?: string;
  configSchema: Record<string, unknown>;
  capabilities: ConnectorCapabilities;
  tags: string[];
  builtIn: boolean;
  installCount: number;
}

interface ConnectorVersionEntry {
  version: string;
  registeredAt: string;
  changelog?: string;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ConnectorDetailSheetProps {
  connectorType: string | null;
  onOpenChange: (open: boolean) => void;
  onInstall?: (type: string) => void;
  isInstalling?: boolean;
  /** Set of connector types already installed in the current tenant */
  installedTypes?: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ICON_MAP: Record<string, IconComponent> = {
  Database,
  Globe,
  FileText,
  Zap,
  Radio,
  Box,
};

function resolveIcon(
  iconName: string | undefined,
  category: ConnectorCategory,
): IconComponent {
  if (iconName !== undefined && iconName in ICON_MAP) {
    return ICON_MAP[iconName] as IconComponent;
  }
  switch (category) {
    case "database":
      return Database;
    case "api":
      return Globe;
    case "file":
      return FileText;
    case "webhook":
      return Zap;
    case "streaming":
      return Radio;
    default:
      return Box;
  }
}

// Render a JSON Schema "properties" object as a readable list of field rows.
// Only one level deep — nested objects show a "(nested object)" hint.
function SchemaFieldList({ schema }: { schema: Record<string, unknown> }) {
  const properties = schema["properties"] as Record<string, Record<string, unknown>> | undefined;
  const required = Array.isArray(schema["required"])
    ? new Set(schema["required"] as string[])
    : new Set<string>();

  if (properties === undefined || Object.keys(properties).length === 0) {
    return (
      <p className="text-sm text-[var(--color-muted-foreground)] italic">
        No configuration fields defined.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {Object.entries(properties).map(([key, prop]) => {
        const type = typeof prop["type"] === "string" ? prop["type"] : "unknown";
        const description = typeof prop["description"] === "string" ? prop["description"] : "";
        const isRequired = required.has(key);
        const format = typeof prop["format"] === "string" ? prop["format"] : undefined;
        const defaultVal = prop["default"];

        return (
          <li
            key={key}
            className="rounded-md border border-[var(--color-border)] bg-[var(--color-muted)]/40 px-3 py-2 text-sm"
          >
            <div className="flex items-center gap-2">
              <code className="font-mono text-xs font-semibold text-[var(--color-foreground)]">
                {key}
              </code>
              <span className="text-xs text-[var(--color-muted-foreground)]">
                {format === "password" ? "string (secret)" : type}
              </span>
              {isRequired && (
                <Badge className="border-transparent bg-red-100 text-red-700 text-[10px] px-1 py-0 dark:bg-red-900/30 dark:text-red-300">
                  required
                </Badge>
              )}
              {defaultVal !== undefined && (
                <span className="text-xs text-[var(--color-muted-foreground)]">
                  default: <code className="font-mono">{JSON.stringify(defaultVal)}</code>
                </span>
              )}
            </div>
            {description !== "" && (
              <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                {description}
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function CapabilityRow({
  label,
  supported,
}: {
  label: string;
  supported: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {supported ? (
        <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" aria-hidden="true" />
      ) : (
        <XCircle className="h-4 w-4 text-[var(--color-muted-foreground)]" aria-hidden="true" />
      )}
      <span className={supported ? "text-[var(--color-foreground)]" : "text-[var(--color-muted-foreground)]"}>
        {label}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ConnectorDetailSheet component
// ---------------------------------------------------------------------------

export function ConnectorDetailSheet({
  connectorType,
  onOpenChange,
  onInstall,
  isInstalling = false,
  installedTypes,
}: ConnectorDetailSheetProps) {
  const client = useApiClient();
  const isOpen = connectorType !== null;

  // Fetch connector details from the registry.
  const detailQuery = useQuery({
    queryKey: ["connector-registry", connectorType],
    queryFn: ({ signal }) =>
      client.get<{ data: ConnectorRegistryEntry }>(
        `/v1/connector-registry/${encodeURIComponent(connectorType ?? "")}`,
        undefined,
        { signal },
      ),
    enabled: connectorType !== null,
  });

  // Fetch version history in parallel.
  const versionsQuery = useQuery({
    queryKey: ["connector-registry-versions", connectorType],
    queryFn: ({ signal }) =>
      client.get<{ data: ConnectorVersionEntry[] }>(
        `/v1/connector-registry/${encodeURIComponent(connectorType ?? "")}/versions`,
        undefined,
        { signal },
      ),
    enabled: connectorType !== null,
  });

  const entry = detailQuery.data?.data;
  const versions = versionsQuery.data?.data ?? [];
  const installed = connectorType !== null && (installedTypes?.has(connectorType) ?? false);

  const IconComponent = entry !== undefined
    ? resolveIcon(entry.icon, entry.category)
    : Box;

  return (
    <Sheet open={isOpen} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {detailQuery.isLoading ? (
          <div className="space-y-4 p-6">
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : detailQuery.isError ? (
          <div className="p-6 text-sm text-[var(--color-muted-foreground)]">
            Failed to load connector details.{" "}
            {(detailQuery.error as ApiError | undefined)?.message ?? ""}
          </div>
        ) : entry !== undefined ? (
          <>
            <SheetHeader className="mb-4">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[var(--color-muted)]">
                  <IconComponent className="h-6 w-6 text-[var(--color-foreground)]" aria-hidden="true" />
                </div>
                <div>
                  <SheetTitle>{entry.displayName}</SheetTitle>
                  <SheetDescription>
                    v{entry.version} · by {entry.author}
                  </SheetDescription>
                </div>
              </div>
            </SheetHeader>

            {/* Description */}
            <p className="mb-4 text-sm text-[var(--color-foreground)]">
              {entry.description}
            </p>

            {/* Tags */}
            {entry.tags.length > 0 && (
              <div className="mb-4 flex flex-wrap gap-1.5">
                {entry.tags.map((tag) => (
                  <Badge
                    key={tag}
                    variant="outline"
                    className="text-xs"
                  >
                    {tag}
                  </Badge>
                ))}
              </div>
            )}

            <Separator className="mb-4" />

            {/* Capabilities */}
            <section className="mb-4" aria-labelledby="capabilities-heading">
              <h3
                id="capabilities-heading"
                className="mb-2 text-sm font-semibold text-[var(--color-foreground)]"
              >
                Capabilities
              </h3>
              <div className="space-y-1.5">
                <CapabilityRow
                  label="Incremental sync"
                  supported={entry.capabilities.supportsIncremental}
                />
                <CapabilityRow
                  label="Real-time streaming"
                  supported={entry.capabilities.supportsRealtime}
                />
                <CapabilityRow
                  label="Change-data capture (CDC)"
                  supported={entry.capabilities.supportsCdc}
                />
              </div>
            </section>

            <Separator className="mb-4" />

            {/* Config schema */}
            <section className="mb-4" aria-labelledby="schema-heading">
              <h3
                id="schema-heading"
                className="mb-2 text-sm font-semibold text-[var(--color-foreground)]"
              >
                Configuration fields
              </h3>
              <SchemaFieldList schema={entry.configSchema} />
            </section>

            {/* Version history (shows only if loaded) */}
            {versions.length > 0 && (
              <>
                <Separator className="mb-4" />
                <section aria-labelledby="versions-heading">
                  <h3
                    id="versions-heading"
                    className="mb-2 text-sm font-semibold text-[var(--color-foreground)]"
                  >
                    Version history
                  </h3>
                  <ul className="space-y-2">
                    {versions.slice(0, 5).map((v) => (
                      <li
                        key={v.version}
                        className="flex items-start justify-between gap-2 text-sm"
                      >
                        <span className="font-mono font-semibold">{v.version}</span>
                        <span className="text-xs text-[var(--color-muted-foreground)]">
                          {new Date(v.registeredAt).toLocaleDateString()}
                        </span>
                        {v.changelog !== undefined && (
                          <span className="text-xs text-[var(--color-muted-foreground)]">
                            {v.changelog}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              </>
            )}

            {/* Install button */}
            {onInstall !== undefined && (
              <div className="mt-6">
                <Button
                  className="w-full"
                  variant={installed ? "outline" : "default"}
                  onClick={() => onInstall(entry.type)}
                  disabled={isInstalling}
                  aria-busy={isInstalling}
                >
                  {isInstalling
                    ? "Installing…"
                    : installed
                      ? "Already installed — configure"
                      : `Install ${entry.displayName}`}
                </Button>
              </div>
            )}
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
