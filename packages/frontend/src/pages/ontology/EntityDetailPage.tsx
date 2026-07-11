/**
 * EntityDetailPage — view/edit a single entity type.
 * Route: /ontology/$entityType
 *
 * When entityType === "new", renders a blank EntityEditor to create a new entity.
 * Otherwise fetches GET /api/v1/ontology/{entityType} and allows editing.
 *
 * The "Data Preview" tab (NCA-014) fetches the first 20 records for the entity
 * via GET /v1/ontology/{entityType}/data and renders them in a scrollable table.
 * A "Query this entity" button links to the interactive query builder.
 */
import React from "react";
import { useParams, useNavigate, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { EmptyState } from "@/components/shared/EmptyState.js";
import { EntityEditor, type EntityEditorValues } from "@/components/ontology/EntityEditor.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs.js";
import { Button } from "@/components/ui/button.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.js";
import { useApiClient, type ApiResponse, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";
import type { EntitySummary } from "@/components/ontology/EntityList.js";
import type { FieldType } from "@/components/ontology/FieldRow.js";
import { Search } from "lucide-react";

// ---------------------------------------------------------------------------
// API types
// ---------------------------------------------------------------------------

interface EntityField {
  name: string;
  type: FieldType;
  required: boolean;
  description: string;
}

interface EntityRelationship {
  fieldName: string;
  targetEntity: string;
  cardinality: "ONE_TO_ONE" | "ONE_TO_MANY" | "MANY_TO_MANY";
}

interface EntityDetail extends EntitySummary {
  fields: EntityField[];
  relationships: EntityRelationship[];
}

// ---------------------------------------------------------------------------
// DataPreviewTab — fetches the first 20 records and renders a dynamic table
// ---------------------------------------------------------------------------

interface DataPreviewResponse {
  data: Record<string, unknown>[];
}

function DataPreviewTab({ entityName, fields }: { entityName: string; fields: EntityField[] }) {
  const client = useApiClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["ontology-preview", entityName],
    queryFn: ({ signal }) =>
      client.get<DataPreviewResponse>(
        `/v1/ontology/${entityName}/data`,
        { limit: 20 },
        { signal },
      ),
    // Preview data may be stale quickly; refetch when tab is focused
    staleTime: 10_000,
  });

  const previewInner = (data as unknown as { data?: DataPreviewResponse })?.data ?? data;
  const rows = previewInner?.data ?? [];
  // Derive column names: prefer schema field order, then any extra keys from first row.
  // Accessing rows[0] only when rows.length > 0 (non-null assertion safe here).
  const schemaCols = fields.map((f) => f.name);
  const firstRow = rows.length > 0 ? rows[0] : undefined;
  const extraCols = firstRow !== undefined
    ? Object.keys(firstRow).filter((k) => !schemaCols.includes(k))
    : [];
  const columns = [...schemaCols, ...extraCols];

  if (isLoading) {
    return (
      <div className="space-y-2 mt-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="mt-4 rounded-lg border border-[var(--color-destructive)]/30 bg-[var(--color-destructive)]/5 p-4 text-sm text-[var(--color-destructive)]">
        Failed to load data preview. The data endpoint may not be available for this entity yet.
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="mt-4 text-sm text-[var(--color-muted-foreground)]">
        No records found for this entity.
      </p>
    );
  }

  return (
    <div className="mt-4 overflow-x-auto rounded-lg border border-[var(--color-border)]">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((col) => (
              <TableHead key={col} className="whitespace-nowrap font-mono text-xs">
                {col}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={i}>
              {columns.map((col) => {
                const value = row[col];
                const display =
                  value === null || value === undefined
                    ? <span className="italic text-[var(--color-muted-foreground)]">null</span>
                    : typeof value === "object"
                    ? <span className="font-mono text-[10px]">{JSON.stringify(value)}</span>
                    : String(value);
                return (
                  <TableCell key={col} className="max-w-xs truncate text-xs">
                    {display}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="px-3 py-2 text-[10px] text-[var(--color-muted-foreground)]">
        Showing up to 20 records. Use the Query Builder for full exploration.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EntityDetailPage component
// ---------------------------------------------------------------------------

export function EntityDetailPage() {
  const { entityType } = useParams({ from: "/authenticated/ontology/$entityType" });
  const client = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const isNew = entityType === "new";

  const { data: entityData, isLoading, isError } = useQuery({
    queryKey: ["ontology", entityType],
    queryFn: () => client.get<ApiResponse<EntityDetail>>(`/v1/ontology/${entityType}`),
    enabled: !isNew,
  });

  const { data: allEntitiesData } = useQuery({
    queryKey: ["ontology"],
    queryFn: () => client.get<{ data: EntitySummary[] }>("/v1/ontology"),
  });

  const createEntity = useMutation({
    mutationFn: (values: EntityEditorValues) =>
      client.post<ApiResponse<EntityDetail>>("/v1/ontology", values),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["ontology"] });
      const createdEntity = (result as unknown as { data?: ApiResponse<EntityDetail> })?.data?.data ?? result.data;
      toast({ title: `Entity "${createdEntity.name}" created` });
      void navigate({ to: "/ontology/$entityType", params: { entityType: createdEntity.name } });
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : "Failed to create entity";
      toast({ title: message, variant: "destructive" });
    },
  });

  const updateEntity = useMutation({
    mutationFn: (values: EntityEditorValues) =>
      client.patch<ApiResponse<EntityDetail>>(`/v1/ontology/${entityType}`, values),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ontology"] });
      void queryClient.invalidateQueries({ queryKey: ["ontology", entityType] });
      toast({ title: "Entity updated" });
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : "Failed to update entity";
      toast({ title: message, variant: "destructive" });
    },
  });

  const entity = (entityData as unknown as { data?: ApiResponse<EntityDetail> })?.data?.data ?? (entityData as ApiResponse<EntityDetail> | undefined)?.data;
  const allEntitiesInner = (allEntitiesData as unknown as { data?: { data: EntitySummary[] } })?.data?.data ?? (allEntitiesData as { data: EntitySummary[] } | undefined)?.data;
  const allEntities: EntitySummary[] = Array.isArray(allEntitiesInner) ? allEntitiesInner : [];
  const allEntityTypes = allEntities
    .map((e) => e.name)
    .filter((n) => n !== entityType);

  const defaultValues: EntityEditorValues | undefined =
    entity !== undefined
      ? {
          name: entity.name,
          description: entity.description ?? "",
          fields: entity.fields,
          relationships: entity.relationships,
        }
      : undefined;

  if (!isNew && isError) {
    return (
      <div className="flex-1 p-6">
        <EmptyState
          title="Entity not found"
          actionLabel="Back to ontology"
          onAction={() => void navigate({ to: "/ontology" })}
        />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader
        title={isNew ? "New entity" : (entity?.name ?? entityType)}
        breadcrumbs={[
          { label: "Platform" },
          { label: "Data Models", href: "/ontology" },
          { label: isNew ? "New" : (entity?.name ?? entityType) },
        ]}
        actions={
          !isNew ? (
            <Link
              to="/ontology/query"
              search={{ entity: entityType } as Record<string, string>}
            >
              <Button variant="outline" size="sm">
                <Search className="h-4 w-4 mr-2" aria-hidden="true" />
                Query this entity
              </Button>
            </Link>
          ) : undefined
        }
      />

      <div className="p-6 max-w-3xl">
        {!isNew && isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-10 w-64" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : isNew ? (
          // New entity has no tabs — only the schema editor
          <EntityEditor
            entityTypes={allEntityTypes}
            onSubmit={(values) => { createEntity.mutate(values); }}
            isSubmitting={createEntity.isPending}
            submitLabel="Create entity"
          />
        ) : (
          // Existing entity: Schema editor + Data Preview tabs (NCA-014)
          <Tabs defaultValue="schema">
            <TabsList>
              <TabsTrigger value="schema">Schema</TabsTrigger>
              <TabsTrigger value="preview">Data Preview</TabsTrigger>
            </TabsList>

            <TabsContent value="schema">
              <div className="mt-4">
                <EntityEditor
                  entityTypes={allEntityTypes}
                  {...(defaultValues !== undefined ? { defaultValues } : {})}
                  onSubmit={(values) => { updateEntity.mutate(values); }}
                  isSubmitting={updateEntity.isPending}
                  submitLabel="Save changes"
                />
              </div>
            </TabsContent>

            <TabsContent value="preview">
              <DataPreviewTab
                entityName={entityType}
                fields={entity?.fields ?? []}
              />
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}
