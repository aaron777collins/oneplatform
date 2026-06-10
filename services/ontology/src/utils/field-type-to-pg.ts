export type FieldType = "string" | "number" | "boolean" | "date" | "json" | "reference" | "enum" | "array";

const FIELD_TYPE_MAP: Record<FieldType, string> = {
  string: "TEXT",
  number: "NUMERIC(19, 4)",
  boolean: "BOOLEAN",
  date: "TIMESTAMPTZ",
  json: "JSONB",
  reference: "UUID",
  enum: "TEXT",
  array: "JSONB",
};

export function fieldTypeToPostgres(fieldType: FieldType): string {
  return FIELD_TYPE_MAP[fieldType];
}
