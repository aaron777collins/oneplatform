/**
 * EntityList — table of entity types with expandable rows for data catalog view.
 *
 * Shows entity name, field count, relationship count, last modified time,
 * and View / Query actions. Expanding a row reveals the entity's field schema:
 * field name, type badge, and description. This gives users a quick data
 * catalog view without navigating to a separate page (NCA-002).
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
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { RelativeTime } from "@/components/shared/RelativeTime.js";
import { EmptyState } from "@/components/shared/EmptyState.js";
import { Database, ChevronDown, ChevronRight, Search } from "lucide-react";
import { useApiClient } from "@/lib/api-client.js";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EntitySummary {
  name: string;
  // Canonical URL-safe identifier used for entity detail routes and API lookups.
  // Falls back to `name` in the UI only when a legacy record lacks a slug.
  slug: string;
  description?: string;
  fieldCount: number;
  relationshipCount: number;
  updatedAt: string;
}

interface EntityField {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

interface EntityDetail extends EntitySummary {
  fields: EntityField[];
  relationships: unknown[];
}

export interface EntityListProps {
  entities: EntitySummary[];
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: (() => void) | undefined;
}

// ---------------------------------------------------------------------------
// ExpandedFieldsRow — fetches and renders schema fields for a single entity
// ---------------------------------------------------------------------------

function ExpandedFieldsRow({ entitySlug }: { entitySlug: string }) {
  const client = useApiClient();
  const { data, isLoading } = useQuery({
    queryKey: ["ontology", entitySlug],
    queryFn: () => client.get<{ data: EntityDetail }>(`/v1/ontology/${entitySlug}`),
    // Keep cached — user may collapse and re-expand without a refetch
    staleTime: 30_000,
  });

  const fields = data?.data.fields ?? [];

  return (
    <TableRow>
      {/* Indent under the expand toggle column */}
      <TableCell colSpan={6} className="bg-[var(--color-muted)]/30 px-6 pb-4 pt-2">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-4 w-full" />
            ))}
          </div>
        ) : fields.length === 0 ? (
          <p className="text-xs text-[var(--color-muted-foreground)]">No fields defined yet.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-[var(--color-muted-foreground)]">
                <th className="py-1 text-left font-medium w-40">Field</th>
                <th className="py-1 text-left font-medium w-28">Type</th>
                <th className="py-1 text-left font-medium">Description</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((field) => (
                <tr key={field.name} className="border-t border-[var(--color-border)]/50">
                  <td className="py-1.5 font-mono font-medium">{field.name}</td>
                  <td className="py-1.5">
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                      {field.type}
                    </Badge>
                    {field.required && (
                      <span className="ml-1 text-[var(--color-destructive)] text-[10px]">*</span>
                    )}
                  </td>
                  <td className="py-1.5 text-[var(--color-muted-foreground)]">
                    {field.description !== "" ? field.description : <span className="italic">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableCell>
    </TableRow>
  );
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
          <TableCell><Skeleton className="h-4 w-4" /></TableCell>
          <TableCell><Skeleton className="h-4 w-32" /></TableCell>
          <TableCell><Skeleton className="h-4 w-8" /></TableCell>
          <TableCell><Skeleton className="h-4 w-8" /></TableCell>
          <TableCell><Skeleton className="h-4 w-24" /></TableCell>
          <TableCell><Skeleton className="h-4 w-20" /></TableCell>
        </TableRow>
      ))}
    </>
  );
}

export function EntityList({ entities, isLoading = false, isError = false, onRetry }: EntityListProps) {
  const navigate = useNavigate();
  // Track which entity rows are currently expanded to show field schema
  const [expandedEntities, setExpandedEntities] = React.useState<Set<string>>(new Set());

  function toggleExpanded(entityName: string) {
    setExpandedEntities((prev) => {
      const next = new Set(prev);
      if (next.has(entityName)) {
        next.delete(entityName);
      } else {
        next.add(entityName);
      }
      return next;
    });
  }

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
          <TableHead className="w-8" />
          <TableHead>Entity</TableHead>
          <TableHead className="w-20 text-right">Fields</TableHead>
          <TableHead className="w-28 text-right">Relationships</TableHead>
          <TableHead className="w-36">Last modified</TableHead>
          <TableHead className="w-32" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {isLoading ? (
          <SkeletonRows />
        ) : entities.length === 0 ? (
          <TableRow>
            <TableCell colSpan={6}>
              <EmptyState
                icon={DatabaseIcon}
                title="No data models yet"
                description="Create your first entity type to define how your data is structured. Entity types describe the shape of your data (like 'Customer', 'Order', or 'Product') and the fields they contain."
              />
            </TableCell>
          </TableRow>
        ) : (
          entities.flatMap((entity) => {
            const isExpanded = expandedEntities.has(entity.name);
            return [
              <TableRow key={entity.name}>
                <TableCell className="w-8 pr-0">
                  <button
                    type="button"
                    onClick={() => toggleExpanded(entity.name)}
                    className="flex h-6 w-6 items-center justify-center rounded text-[var(--color-muted-foreground)] hover:bg-[var(--color-accent)] hover:text-[var(--color-accent-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
                    aria-label={isExpanded ? `Collapse ${entity.name} fields` : `Expand ${entity.name} fields`}
                    aria-expanded={isExpanded}
                  >
                    {isExpanded
                      ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                      : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                    }
                  </button>
                </TableCell>
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
                  <div className="flex items-center gap-2">
                    <Link
                      to="/ontology/$entityType"
                      params={{ entityType: entity.slug }}
                      className="text-xs text-[var(--color-primary)] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] rounded-sm"
                    >
                      View
                    </Link>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() =>
                        void navigate({
                          to: "/ontology/query",
                          search: { entity: entity.slug } as Record<string, string>,
                        })
                      }
                      aria-label={`Query ${entity.name} entity`}
                    >
                      <Search className="h-3 w-3 mr-1" aria-hidden="true" />
                      Query
                    </Button>
                  </div>
                </TableCell>
              </TableRow>,
              // Render expanded schema row immediately after each entity row
              ...(isExpanded
                ? [<ExpandedFieldsRow key={`${entity.name}-fields`} entitySlug={entity.slug} />]
                : []),
            ];
          })
        )}
      </TableBody>
    </Table>
  );
}
