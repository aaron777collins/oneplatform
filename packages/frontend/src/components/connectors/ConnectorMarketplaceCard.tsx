/**
 * ConnectorMarketplaceCard — displays one connector type in the marketplace grid.
 *
 * Shows the connector icon, name, category badge, description, install count,
 * author, and an "Installed" badge when the tenant already has this type wired.
 * Clicking the card body invokes onClick for detail navigation; the Install
 * button fires onInstall and is separate from the navigation click so it does
 * not navigate away.
 */
import * as React from "react";
import {
  Database as DatabaseIcon,
  Globe as GlobeIcon,
  FileText as FileTextIcon,
  Zap as ZapIcon,
  Radio as RadioIcon,
  Box as BoxIcon,
  Download,
  CheckCircle2,
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
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectorCategory =
  | "database"
  | "api"
  | "file"
  | "streaming"
  | "webhook"
  | "custom";

export interface ConnectorMarketplaceCardData {
  type: string;
  displayName: string;
  description: string;
  version: string;
  category: ConnectorCategory;
  author: string;
  icon?: string;
  installCount: number;
  builtIn: boolean;
  installed?: boolean;
}

export interface ConnectorMarketplaceCardProps {
  connector: ConnectorMarketplaceCardData;
  onClick?: (type: string) => void;
  onInstall?: (type: string) => void;
  isInstalling?: boolean;
  className?: string;
}

// ---------------------------------------------------------------------------
// Category metadata
// ---------------------------------------------------------------------------

const CATEGORY_LABELS: Record<ConnectorCategory, string> = {
  database: "Database",
  api: "API",
  file: "File",
  streaming: "Streaming",
  webhook: "Webhook",
  custom: "Custom",
};

const CATEGORY_CLASSES: Record<ConnectorCategory, string> = {
  database:
    "border-transparent bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  api: "border-transparent bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  file: "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  streaming:
    "border-transparent bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
  webhook:
    "border-transparent bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  custom:
    "border-transparent bg-[var(--color-muted)] text-[var(--color-muted-foreground)]",
};

// Icon is stored as a string name in the registry entry. We map the string to
// a Lucide component here so the backend never imports frontend deps.
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
  // Fall back to a sensible default per category.
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

// ---------------------------------------------------------------------------
// ConnectorMarketplaceCard component
// ---------------------------------------------------------------------------

export function ConnectorMarketplaceCard({
  connector,
  onClick,
  onInstall,
  isInstalling = false,
  className,
}: ConnectorMarketplaceCardProps) {
  const {
    type,
    displayName,
    description,
    version,
    category,
    author,
    icon,
    installCount,
    installed = false,
  } = connector;

  const IconComponent = resolveIcon(icon, category);

  function handleCardClick(e: React.MouseEvent) {
    // Don't navigate if the user clicked the install button.
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;
    onClick?.(type);
  }

  return (
    <Card
      className={cn(
        "flex flex-col transition-shadow hover:shadow-md",
        onClick !== undefined && "cursor-pointer",
        className,
      )}
      onClick={handleCardClick}
      role={onClick !== undefined ? "article" : undefined}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {/* Icon container */}
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--color-muted)]">
              <IconComponent className="h-5 w-5 text-[var(--color-foreground)]" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <CardTitle className="truncate text-base font-semibold">
                {displayName}
              </CardTitle>
              <p className="text-xs text-[var(--color-muted-foreground)]">
                v{version} · by {author}
              </p>
            </div>
          </div>

          {/* Installed badge */}
          {installed && (
            <Badge
              className="shrink-0 border-transparent bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"
              aria-label="Already installed"
            >
              <CheckCircle2 className="mr-1 h-3 w-3" aria-hidden="true" />
              Installed
            </Badge>
          )}
        </div>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-3">
        {/* Category badge */}
        <Badge className={cn("w-fit text-xs", CATEGORY_CLASSES[category])}>
          {CATEGORY_LABELS[category]}
        </Badge>

        {/* Description */}
        <p className="line-clamp-2 flex-1 text-sm text-[var(--color-muted-foreground)]">
          {description}
        </p>

        {/* Footer row: install count + install button */}
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-[var(--color-muted-foreground)]">
            {installCount.toLocaleString()} install{installCount !== 1 ? "s" : ""}
          </span>

          {onInstall !== undefined && (
            <Button
              variant={installed ? "outline" : "default"}
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onInstall(type);
              }}
              disabled={isInstalling}
              aria-busy={isInstalling}
              aria-label={installed ? `Configure ${displayName}` : `Install ${displayName}`}
            >
              {!installed && (
                <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
              )}
              {isInstalling
                ? "Installing…"
                : installed
                  ? "Configure"
                  : "Install"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
