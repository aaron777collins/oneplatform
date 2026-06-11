/**
 * EntityEditor — full editor for an entity type's fields and relationships.
 *
 * Manages a react-hook-form with two field arrays:
 * - fields: list of EntityFieldFormValue
 * - relationships: list of RelationshipFormValue
 *
 * Zod validation enforces unique field names within the entity.
 * The caller receives the final form values via onSubmit.
 */
import * as React from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Separator } from "@/components/ui/separator.js";
import { FieldRow, type EntityFieldFormValue, type FieldType, type EntityFormShape } from "./FieldRow.js";
import { RelationshipEditor, type RelationshipFormValue } from "./RelationshipEditor.js";

// ---------------------------------------------------------------------------
// Form schema (mirrors EntityFormShape from FieldRow)
// ---------------------------------------------------------------------------

const fieldSchema = z.object({
  name: z.string()
    .min(1, "Field name is required")
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "Field name must be a valid identifier"),
  type: z.enum(["string", "number", "integer", "boolean", "date", "datetime", "uuid", "json"] as const),
  required: z.boolean(),
  description: z.string(),
});

const relationshipSchema = z.object({
  fieldName: z.string().min(1, "Field name is required"),
  targetEntity: z.string().min(1, "Target entity is required"),
  cardinality: z.enum(["ONE_TO_ONE", "ONE_TO_MANY", "MANY_TO_MANY"] as const),
});

const entityFormSchema = z.object({
  name: z.string()
    .min(1, "Entity name is required")
    .regex(/^[A-Z][a-zA-Z0-9]*$/, "Entity name must start with a capital letter"),
  description: z.string(),
  fields: z.array(fieldSchema).refine(
    (fields) => {
      const names = fields.map((f) => f.name.toLowerCase());
      return names.length === new Set(names).size;
    },
    { message: "Field names must be unique" },
  ),
  relationships: z.array(relationshipSchema),
});

// EntityFormValues must match EntityFormShape exactly
type EntityFormValues = EntityFormShape;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EntityEditorValues {
  name: string;
  description: string;
  fields: EntityFieldFormValue[];
  relationships: RelationshipFormValue[];
}

export interface EntityEditorProps {
  /** All entity type names available for relationship targets */
  entityTypes: string[];
  defaultValues?: EntityEditorValues;
  onSubmit: (values: EntityEditorValues) => void | Promise<void>;
  isSubmitting?: boolean;
  submitLabel?: string;
}

// ---------------------------------------------------------------------------
// EntityEditor component
// ---------------------------------------------------------------------------

export function EntityEditor({
  entityTypes,
  defaultValues,
  onSubmit,
  isSubmitting = false,
  submitLabel = "Save entity",
}: EntityEditorProps) {
  const form = useForm<EntityFormValues>({
    resolver: zodResolver(entityFormSchema),
    defaultValues: defaultValues ?? {
      name: "",
      description: "",
      fields: [],
      relationships: [],
    },
  });

  const fieldsArray = useFieldArray({
    control: form.control,
    name: "fields",
  });

  const relationshipsArray = useFieldArray({
    control: form.control,
    name: "relationships",
  });

  function handleAddField() {
    const newField: EntityFieldFormValue & { type: FieldType } = {
      name: "",
      type: "string",
      required: false,
      description: "",
    };
    fieldsArray.append(newField);
  }

  async function handleSubmit(values: EntityFormValues) {
    await onSubmit(values);
  }

  return (
    <form
      onSubmit={(e) => void form.handleSubmit(handleSubmit)(e)}
      className="space-y-6"
      noValidate
    >
      {/* Entity metadata */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="entity-name">
            Entity name
            <span className="ml-1 text-[var(--color-destructive)]" aria-hidden>*</span>
          </Label>
          <Input
            id="entity-name"
            placeholder="e.g. Customer"
            {...form.register("name")}
            aria-invalid={form.formState.errors.name !== undefined}
          />
          {form.formState.errors.name?.message !== undefined && (
            <p className="text-xs text-[var(--color-destructive)]" role="alert">
              {form.formState.errors.name.message}
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="entity-description">Description</Label>
          <Input
            id="entity-description"
            placeholder="What does this entity represent?"
            {...form.register("description")}
          />
        </div>
      </div>

      <Separator />

      {/* Fields */}
      <section>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Fields ({fieldsArray.fields.length})</h3>
          <Button type="button" variant="outline" size="sm" onClick={handleAddField}>
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Add field
          </Button>
        </div>

        {fieldsArray.fields.length === 0 ? (
          <p className="mt-2 text-sm text-[var(--color-muted-foreground)]">
            No fields yet. Add at least one field.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {/* Column headers */}
            <div className="flex items-center gap-2 px-1 text-xs font-medium text-[var(--color-muted-foreground)]">
              <span className="flex-1">Name</span>
              <span className="w-32">Type</span>
              <span className="w-12">Req</span>
              <span className="w-40">Description</span>
              <span className="w-7" />
            </div>
            {fieldsArray.fields.map((_field, index) => {
              const nameError = form.formState.errors.fields?.[index]?.name?.message;
              return (
                <FieldRow
                  key={_field.id}
                  index={index}
                  register={form.register}
                  control={form.control}
                  {...(nameError !== undefined ? { nameError } : {})}
                  onRemove={(i) => fieldsArray.remove(i)}
                />
              );
            })}
          </div>
        )}

        {/* Field-level validation error from the array refine */}
        {form.formState.errors.fields?.root?.message !== undefined && (
          <p className="mt-2 text-xs text-[var(--color-destructive)]" role="alert">
            {form.formState.errors.fields.root.message}
          </p>
        )}
      </section>

      <Separator />

      {/* Relationships */}
      <section>
        <h3 className="mb-3 text-sm font-semibold">
          Relationships ({relationshipsArray.fields.length})
        </h3>
        <RelationshipEditor
          entityTypes={entityTypes}
          control={form.control}
          fieldArray={relationshipsArray}
        />
      </section>

      <Separator />

      <Button type="submit" disabled={isSubmitting} aria-busy={isSubmitting}>
        {isSubmitting ? (
          <span className="flex items-center gap-2">
            <span
              className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
              aria-hidden
            />
            Saving…
          </span>
        ) : (
          submitLabel
        )}
      </Button>
    </form>
  );
}
