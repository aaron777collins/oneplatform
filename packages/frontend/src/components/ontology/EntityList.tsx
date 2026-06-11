/**
 * EntityList — table of entity types with summary stats.
 *
 * Shows entity name, field count, relationship count, last modified time,
 * and a "View" link. Clicking a row navigates to EntityDetailPage.
 */
import * as React from "react";
import { Link } from "@tanstack/react-router";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { RelativeTime } from "@/components/shared/RelativeTime.js";
import { EmptyState } from "@/components/shared/EmptyState.js";
import { Database } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EntitySummary {
  name: string;
  description?: string;
  fieldCount: number;
  relationshipCount: number;
  updatedAt: string;
}

export interface EntityListProps {
  entities: EntitySummary[];
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: (() => void) | undefined;
}

// ---------------------------------------------------------------------------
// EntityList component
// ---------------------------------------------------------------------------

// Wrapper satisfies React.ComponentType<{ className?: string }> under exactOptionalPropertyTypes
function DatabaseIcon({ className }: { className?: string }) {
  return <Database className={className} />;
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 4 }).map((_, i) => (
        <TableRow key={i}>
          <TableCell><Skeleton className="h-4 w-32" /></TableCell>
          <TableCell><Skeleton className="h-4 w-8" /></TableCell>
          <TableCell><Skeleton className="h-4 w-8" /></TableCell>
          <TableCell><Skeleton className="h-4 w-24" /></TableCell>
          <TableCell><Skeleton className="h-4 w-12" /></TableCell>
        </TableRow>
      ))}
    </>
  );
}

export function EntityList({ entities, isLoading = false, isError = false, onRetry }: EntityListProps) {
  if (isError) {
    return (
      <EmptyState
        title="Failed to load entities"
        description="Check your connection and try again."
        {...(onRetry !== undefined ? { actionLabel: "Retry", onAction: onRetry } : {})}
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Entity</TableHead>
          <TableHead className="w-20 text-right">Fields</TableHead>
          <TableHead className="w-28 text-right">Relationships</TableHead>
          <TableHead className="w-36">Last modified</TableHead>
          <TableHead className="w-16" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {isLoading ? (
          <SkeletonRows />
        ) : entities.length === 0 ? (
          <TableRow>
            <TableCell colSpan={5}>
              <EmptyState
                icon={DatabaseIcon}
                title="No entities yet"
                description="Create your first entity type to start building your data model."
              />
            </TableCell>
          </TableRow>
        ) : (
          entities.map((entity) => (
            <TableRow key={entity.name}>
              <TableCell>
                <div>
                  <p className="font-medium">{entity.name}</p>
                  {entity.description !== undefined && (
                    <p className="text-xs text-[var(--color-muted-foreground)]">
                      {entity.description}
                    </p>
                  )}
                </div>
              </TableCell>
              <TableCell className="text-right text-sm">{entity.fieldCount}</TableCell>
              <TableCell className="text-right text-sm">{entity.relationshipCount}</TableCell>
              <TableCell>
                <RelativeTime value={entity.updatedAt} className="text-sm" />
              </TableCell>
              <TableCell>
                <Link
                  to="/ontology/$entityType"
                  params={{ entityType: entity.name }}
                  className="text-xs text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] rounded-sm"
                >
                  View
                </Link>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  );
}
