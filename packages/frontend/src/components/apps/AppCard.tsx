/**
 * AppCard — displays a single app in the grid view.
 *
 * Shows app name, slug, access mode (public/platform-user), current build status,
 * and deploy date. Navigation to detail/editor is handled by the page via onClick.
 */
import * as React from "react";
import { Globe, Lock } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.js";
import { RelativeTime } from "@/components/shared/RelativeTime.js";
import { BuildStatusBadge, type BuildStatus } from "./BuildStatusBadge.js";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AppAccessMode = "public" | "platform-user";

export interface AppCardData {
  id: string;
  name: string;
  slug: string;
  accessMode: AppAccessMode;
  /** Build lifecycle state. Undefined when the server has no build info yet. */
  buildStatus?: BuildStatus;
  /** ISO string of the most recent deploy, undefined if never deployed */
  lastDeployedAt?: string;
}

export interface AppCardProps {
  app: AppCardData;
  onClick?: (id: string) => void;
  onEdit?: (id: string) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// AppCard component
// ---------------------------------------------------------------------------

// Cast Lucide icons to avoid exactOptionalPropertyTypes conflict on className
type IconComponent = React.ComponentType<{ className?: string }>;
const ACCESS_MODE_ICON: Record<AppAccessMode, IconComponent> = {
  public: Globe as IconComponent,
  "platform-user": Lock as IconComponent,
};

const ACCESS_MODE_LABEL: Record<AppAccessMode, string> = {
  public: "Public",
  "platform-user": "Platform users only",
};

export function AppCard({ app, onClick, onEdit, className }: AppCardProps) {
  const { id, name, slug, accessMode, buildStatus, lastDeployedAt } = app;
  const AccessIcon = ACCESS_MODE_ICON[accessMode];

  function handleCardClick(e: React.MouseEvent) {
    // Avoid card navigation when clicking action buttons
    const target = e.target as HTMLElement;
    if (target.closest("button")) return;
    onClick?.(id);
  }

  return (
    <Card
      className={cn(
        "transition-shadow hover:shadow-md",
        onClick !== undefined && "cursor-pointer",
        className,
      )}
      onClick={handleCardClick}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <CardTitle className="truncate text-base font-semibold">{name}</CardTitle>
            <p className="mt-0.5 font-mono text-xs text-[var(--color-muted-foreground)]">
              /{slug}
            </p>
          </div>
          {buildStatus !== undefined ? (
            <BuildStatusBadge status={buildStatus} />
          ) : (
            <span className="rounded-full bg-[var(--color-muted)] px-2 py-0.5 text-xs text-[var(--color-muted-foreground)]">
              Not deployed
            </span>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {/* Access mode indicator */}
        <div className="flex items-center gap-1.5 text-xs text-[var(--color-muted-foreground)]">
          <AccessIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{ACCESS_MODE_LABEL[accessMode]}</span>
        </div>

        {/* Last deploy time */}
        <div className="text-xs text-[var(--color-muted-foreground)]">
          {lastDeployedAt !== undefined ? (
            <span>
              Deployed <RelativeTime value={lastDeployedAt} />
            </span>
          ) : (
            <span>Never deployed</span>
          )}
        </div>

        {/* Edit button */}
        {onEdit !== undefined && (
          <button
            type="button"
            className="w-full rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--color-muted)]"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(id);
            }}
            aria-label={`Edit ${name}`}
          >
            Edit in Monaco
          </button>
        )}
      </CardContent>
    </Card>
  );
}
