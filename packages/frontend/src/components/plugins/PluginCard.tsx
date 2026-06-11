/**
 * PluginCard — displays a single plugin in the grid view.
 *
 * Shows plugin name, type, version, status, and author.
 * Navigation to detail is handled by the page via onClick.
 */
import * as React from "react";
import { Package } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.js";
import { PluginStatusBadge, type PluginStatus } from "./PluginStatusBadge.js";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PluginType =
  | "connector"
  | "transformer"
  | "destination"
  | "auth-provider"
  | "widget";

export interface PluginCardData {
  id: string;
  name: string;
  type: PluginType;
  version: string;
  status: PluginStatus;
  author: string;
  description?: string;
}

export interface PluginCardProps {
  plugin: PluginCardData;
  onClick?: (id: string) => void;
  className?: string;
}

const TYPE_LABELS: Record<PluginType, string> = {
  connector: "Connector",
  transformer: "Transformer",
  destination: "Destination",
  "auth-provider": "Auth Provider",
  widget: "Widget",
};

// ---------------------------------------------------------------------------
// PluginCard component
// ---------------------------------------------------------------------------

export function PluginCard({ plugin, onClick, className }: PluginCardProps) {
  const { id, name, type, version, status, author, description } = plugin;

  return (
    <Card
      className={cn(
        "transition-shadow hover:shadow-md",
        onClick !== undefined && "cursor-pointer",
        className,
      )}
      onClick={() => onClick?.(id)}
      role={onClick !== undefined ? "button" : undefined}
      tabIndex={onClick !== undefined ? 0 : undefined}
      onKeyDown={(e) => {
        if (onClick !== undefined && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onClick(id);
        }
      }}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--color-muted)]">
              <Package className="h-4 w-4 text-[var(--color-muted-foreground)]" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <CardTitle className="truncate text-base font-semibold">{name}</CardTitle>
              <p className="text-xs text-[var(--color-muted-foreground)]">
                {TYPE_LABELS[type]} · v{version}
              </p>
            </div>
          </div>
          <PluginStatusBadge status={status} />
        </div>
      </CardHeader>

      <CardContent className="space-y-2">
        {description !== undefined && (
          <p className="line-clamp-2 text-sm text-[var(--color-muted-foreground)]">
            {description}
          </p>
        )}
        <p className="text-xs text-[var(--color-muted-foreground)]">
          by {author}
        </p>
      </CardContent>
    </Card>
  );
}
