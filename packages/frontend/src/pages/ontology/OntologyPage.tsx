/**
 * OntologyPage — entity list with search, "New Entity" button, migration banner.
 * Route: /ontology
 */
import React, { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus, Search, Upload, Info } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { EntityList, type EntitySummary } from "@/components/ontology/EntityList.js";
import { MigrationBanner, type PendingMigration } from "@/components/ontology/MigrationBanner.js";
import { SchemaInferencePanel } from "@/components/ontology/SchemaInferencePanel.js";
import { useApiClient, type PaginatedResponse, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";
import type { EntityEditorValues } from "@/components/ontology/EntityEditor.js";
import type { FieldType } from "@/components/ontology/FieldRow.js";

// ---------------------------------------------------------------------------
// OntologyPage component
// ---------------------------------------------------------------------------

export function OntologyPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [csvDialogOpen, setCsvDialogOpen] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["ontology"],
    queryFn: () => client.get<PaginatedResponse<EntitySummary>>("/v1/ontology"),
  });

  const { data: migrationsData } = useQuery({
    queryKey: ["ontology-migrations"],
    queryFn: () => client.get<{ data: PendingMigration[] }>("/v1/ontology/migrations"),
  });

  const applyMigration = useMutation({
    mutationFn: (migrationId: string) =>
      client.post(`/v1/ontology/migrations/${migrationId}/confirm`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ontology-migrations"] });
      void queryClient.invalidateQueries({ queryKey: ["ontology"] });
      toast({ title: "Migration applied" });
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : "Failed to apply migration";
      toast({ title: message, variant: "destructive" });
    },
  });

  const rollbackMigration = useMutation({
    mutationFn: (migrationId: string) =>
      client.post(`/v1/ontology/migrations/${migrationId}/rollback`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ontology-migrations"] });
      toast({ title: "Migration rolled back" });
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : "Failed to roll back migration";
      toast({ title: message, variant: "destructive" });
    },
  });

  const createEntityFromCsv = useMutation({
    mutationFn: (body: EntityEditorValues) =>
      client.post("/v1/ontology", body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["ontology"] });
      toast({ title: "Entity created from CSV" });
      setCsvDialogOpen(false);
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : "Failed to create entity";
      toast({ title: message, variant: "destructive" });
    },
  });

  const entities = data?.data ?? [];
  const pendingMigrations = (migrationsData?.data ?? []).filter(
    (m) => m.status === "pending" || m.status === "running",
  );

  const filtered = search.trim().length === 0
    ? entities
    : entities.filter((e) =>
        e.name.toLowerCase().includes(search.toLowerCase()),
      );

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader
        title="Data Models"
        description="Define your data models and schemas."
        breadcrumbs={[{ label: "Platform" }, { label: "Data Models" }]}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => setCsvDialogOpen(true)}
            >
              <Upload className="h-4 w-4" aria-hidden />
              Upload CSV
            </Button>
            <Button onClick={() => void navigate({ to: "/ontology/migrations" })} variant="outline">
              Migrations
            </Button>
            <Button onClick={() => void navigate({ to: "/ontology/$entityType", params: { entityType: "new" } })}>
              <Plus className="h-4 w-4" aria-hidden />
              New entity
            </Button>
          </div>
        }
      />

      <div className="p-6 space-y-4">
        {/* Migration banner */}
        {pendingMigrations.length > 0 && (
          <MigrationBanner
            migrations={pendingMigrations}
            onApply={(id) => applyMigration.mutate(id)}
            onRollback={(id) => rollbackMigration.mutate(id)}
            isApplying={applyMigration.isPending}
            isRollingBack={rollbackMigration.isPending}
          />
        )}

        {/* Search */}
        <div className="relative max-w-sm">
          <Search
            className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted-foreground)]"
            aria-hidden
          />
          <Input
            className="pl-9"
            placeholder="Search entities…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search entity types"
          />
        </div>

        {/* Entity table */}
        <EntityList
          entities={filtered}
          isLoading={isLoading}
          isError={isError}
          onRetry={() => void refetch()}
        />
      </div>

      {/* CSV Upload dialog */}
      <Dialog open={csvDialogOpen} onOpenChange={setCsvDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Create entity from CSV</DialogTitle>
          </DialogHeader>
          <SchemaInferencePanel
            onConfirm={(entityName, columns) => {
              const body: EntityEditorValues = {
                name: entityName,
                description: `Entity inferred from CSV upload`,
                fields: columns.map((col) => ({
                  name: col.fieldName,
                  type: (col.overrideType ?? col.detectedType) as FieldType,
                  required: false,
                  description: col.csvName !== col.fieldName ? `From CSV column: ${col.csvName}` : "",
                })),
                relationships: [],
              };
              createEntityFromCsv.mutate(body);
            }}
            isConfirming={createEntityFromCsv.isPending}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
