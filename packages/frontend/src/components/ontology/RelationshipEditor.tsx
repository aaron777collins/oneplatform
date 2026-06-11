/**
 * RelationshipEditor — add/edit/remove relationships between entity types.
 *
 * Uses the EntityFormShape type from FieldRow for type safety.
 * Designed for exclusive use within EntityEditor.
 */
import * as React from "react";
import { Plus, Trash2 } from "lucide-react";
import type { Control, UseFieldArrayReturn } from "react-hook-form";
import { Controller } from "react-hook-form";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Button } from "@/components/ui/button.js";
import type { EntityFormShape } from "./FieldRow.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CardinalityType = "ONE_TO_ONE" | "ONE_TO_MANY" | "MANY_TO_MANY";

export interface RelationshipFormValue {
  fieldName: string;
  targetEntity: string;
  cardinality: CardinalityType;
}

export interface RelationshipEditorProps {
  /** All entity type names for the target selector */
  entityTypes: string[];
  control: Control<EntityFormShape>;
  fieldArray: UseFieldArrayReturn<EntityFormShape, "relationships", "id">;
}

// ---------------------------------------------------------------------------
// RelationshipEditor component
// ---------------------------------------------------------------------------

const CARDINALITY_LABELS: Record<CardinalityType, string> = {
  ONE_TO_ONE: "1:1",
  ONE_TO_MANY: "1:N",
  MANY_TO_MANY: "M:N",
};

export function RelationshipEditor({
  entityTypes,
  control,
  fieldArray,
}: RelationshipEditorProps) {
  const { fields, append, remove } = fieldArray;

  function handleAdd() {
    const newRel: RelationshipFormValue = {
      fieldName: "",
      targetEntity: entityTypes[0] ?? "",
      cardinality: "ONE_TO_MANY",
    };
    append(newRel);
  }

  return (
    <div className="space-y-3">
      {fields.length === 0 && (
        <p className="text-sm text-[var(--color-muted-foreground)]">
          No relationships defined. Add one below.
        </p>
      )}

      {fields.map((field, index) => (
        <div
          key={field.id}
          className="flex items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-3"
        >
          {/* Field name on source entity */}
          <div className="min-w-0 flex-1">
            <Controller
              control={control}
              name={`relationships.${index}.fieldName`}
              render={({ field: f }) => (
                <Input
                  className="h-8 text-sm"
                  placeholder="Field name"
                  value={f.value}
                  onChange={f.onChange}
                  aria-label={`Relationship ${index + 1} field name`}
                />
              )}
            />
          </div>

          {/* Cardinality */}
          <div className="w-24 shrink-0">
            <Controller
              control={control}
              name={`relationships.${index}.cardinality`}
              render={({ field: f }) => (
                <Select
                  value={f.value}
                  onValueChange={f.onChange}
                >
                  <SelectTrigger className="h-8 text-sm" aria-label={`Relationship ${index + 1} cardinality`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(CARDINALITY_LABELS) as CardinalityType[]).map((c) => (
                      <SelectItem key={c} value={c}>
                        {CARDINALITY_LABELS[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          {/* Target entity */}
          <div className="w-40 shrink-0">
            <Controller
              control={control}
              name={`relationships.${index}.targetEntity`}
              render={({ field: f }) => (
                <Select
                  value={f.value}
                  onValueChange={f.onChange}
                >
                  <SelectTrigger className="h-8 text-sm" aria-label={`Relationship ${index + 1} target entity`}>
                    <SelectValue placeholder="Target entity" />
                  </SelectTrigger>
                  <SelectContent>
                    {entityTypes.map((et) => (
                      <SelectItem key={et} value={et}>
                        {et}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>

          {/* Remove */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-[var(--color-destructive)] hover:bg-[var(--color-destructive)]/10"
            onClick={() => remove(index)}
            aria-label={`Remove relationship ${index + 1}`}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleAdd}
        disabled={entityTypes.length === 0}
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        Add relationship
      </Button>
    </div>
  );
}
