/**
 * EntityDetailPage — view/edit a single entity type.
 * Route: /ontology/$entityType
 *
 * When entityType === "new", renders a blank EntityEditor to create a new entity.
 * Otherwise fetches GET /api/v1/ontology/{entityType} and allows editing.
 */
import React from "react";
import { useParams, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { Skeleton } from "@/components/ui/skeleton.js";
import { EmptyState } from "@/components/shared/EmptyState.js";
import { EntityEditor, type EntityEditorValues } from "@/components/ontology/EntityEditor.js";
import { useApiClient, type ApiResponse, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";
import type { EntitySummary } from "@/components/ontology/EntityList.js";
import type { FieldType } from "@/components/ontology/FieldRow.js";

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
      toast({ title: `Entity "${result.data.name}" created` });
      void navigate({ to: "/ontology/$entityType", params: { entityType: result.data.name } });
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

  const entity = entityData?.data;
  const allEntityTypes = (allEntitiesData?.data ?? [])
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
          { label: "Ontology", href: "/ontology" },
          { label: isNew ? "New" : (entity?.name ?? entityType) },
        ]}
      />

      <div className="p-6 max-w-2xl">
        {!isNew && isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-10 w-64" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          <EntityEditor
            entityTypes={allEntityTypes}
            {...(defaultValues !== undefined ? { defaultValues } : {})}
            onSubmit={(values) => {
              if (isNew) {
                createEntity.mutate(values);
              } else {
                updateEntity.mutate(values);
              }
            }}
            isSubmitting={createEntity.isPending || updateEntity.isPending}
            submitLabel={isNew ? "Create entity" : "Save changes"}
          />
        )}
      </div>
    </div>
  );
}
