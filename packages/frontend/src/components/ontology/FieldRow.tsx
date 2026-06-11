/**
 * FieldRow — single field editor row inside EntityEditor.
 *
 * Renders name, type dropdown, required toggle, and description inline.
 * Designed for exclusive use within EntityEditor; uses the EntityFormValues
 * type directly to avoid react-hook-form generic complexity.
 */
import * as React from "react";
import { Trash2 } from "lucide-react";
import type { UseFormRegister, Control } from "react-hook-form";
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FieldType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "date"
  | "datetime"
  | "uuid"
  | "json";

export const FIELD_TYPE_OPTIONS: { value: FieldType; label: string }[] = [
  { value: "string", label: "String" },
  { value: "number", label: "Number" },
  { value: "integer", label: "Integer" },
  { value: "boolean", label: "Boolean" },
  { value: "date", label: "Date" },
  { value: "datetime", label: "DateTime" },
  { value: "uuid", label: "UUID" },
  { value: "json", label: "JSON" },
];

export interface EntityFieldFormValue {
  name: string;
  type: FieldType;
  required: boolean;
  description: string;
}

// The EntityFormValues shape EntityEditor uses — imported here to avoid circular deps
// by inlining only what FieldRow needs from the form type.
export interface EntityFormShape {
  name: string;
  description: string;
  fields: EntityFieldFormValue[];
  relationships: {
    fieldName: string;
    targetEntity: string;
    cardinality: "ONE_TO_ONE" | "ONE_TO_MANY" | "MANY_TO_MANY";
  }[];
}

export interface FieldRowProps {
  index: number;
  register: UseFormRegister<EntityFormShape>;
  control: Control<EntityFormShape>;
  /** Error message for the field name, if any */
  nameError?: string;
  onRemove: (index: number) => void;
}

// ---------------------------------------------------------------------------
// FieldRow component
// ---------------------------------------------------------------------------

export function FieldRow({ index, register, control, nameError, onRemove }: FieldRowProps) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-card)] p-3">
      {/* Name */}
      <div className="min-w-0 flex-1 space-y-1">
        <Input
          placeholder="Field name"
          {...register(`fields.${index}.name`)}
          className="h-8 text-sm"
          aria-label={`Field ${index + 1} name`}
          aria-invalid={nameError !== undefined}
        />
        {nameError !== undefined && (
          <p className="text-xs text-[var(--color-destructive)]" role="alert">
            {nameError}
          </p>
        )}
      </div>

      {/* Type */}
      <div className="w-32 shrink-0">
        <Controller
          control={control}
          name={`fields.${index}.type`}
          render={({ field }) => (
            <Select
              value={field.value}
              onValueChange={field.onChange}
            >
              <SelectTrigger className="h-8 text-sm" aria-label={`Field ${index + 1} type`}>
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                {FIELD_TYPE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </div>

      {/* Required toggle */}
      <div className="flex shrink-0 items-center gap-1.5 pt-1.5">
        <Controller
          control={control}
          name={`fields.${index}.required`}
          render={({ field }) => (
            <input
              type="checkbox"
              id={`field-required-${index}`}
              checked={field.value}
              onChange={field.onChange}
              className="h-4 w-4 rounded border-[var(--color-input)] accent-[var(--color-primary)]"
              aria-label={`Field ${index + 1} required`}
            />
          )}
        />
        <label
          htmlFor={`field-required-${index}`}
          className="text-xs text-[var(--color-muted-foreground)]"
        >
          Req
        </label>
      </div>

      {/* Description */}
      <div className="w-40 shrink-0">
        <Input
          placeholder="Description (optional)"
          {...register(`fields.${index}.description`)}
          className="h-8 text-xs"
          aria-label={`Field ${index + 1} description`}
        />
      </div>

      {/* Remove */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="mt-0.5 h-7 w-7 shrink-0 text-[var(--color-destructive)] hover:bg-[var(--color-destructive)]/10"
        onClick={() => onRemove(index)}
        aria-label={`Remove field ${index + 1}`}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden />
      </Button>
    </div>
  );
}
