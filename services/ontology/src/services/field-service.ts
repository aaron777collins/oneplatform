import { z, type ZodTypeAny, type ZodString, type ZodNumber } from "zod";
import type { FieldRow, ValidationRule } from "../repositories/types.js";

export function buildFieldZodValidator(field: FieldRow): ZodTypeAny {
  let v: ZodTypeAny;

  switch (field.field_type) {
    case "string": {
      let sv = z.string();
      for (const rule of field.validation_rules) {
        switch (rule.type) {
          case "minLength": sv = sv.min(rule.value as number, rule.message); break;
          case "maxLength": sv = sv.max(rule.value as number, rule.message); break;
          case "pattern": sv = sv.regex(new RegExp(rule.value as string), rule.message); break;
          case "email": sv = sv.email(rule.message); break;
          case "url": sv = sv.url(rule.message); break;
        }
      }
      v = sv;
      break;
    }
    case "number": {
      let nv = z.number();
      for (const rule of field.validation_rules) {
        switch (rule.type) {
          case "min": nv = nv.min(rule.value as number, rule.message); break;
          case "max": nv = nv.max(rule.value as number, rule.message); break;
        }
      }
      v = nv;
      break;
    }
    case "boolean":
      v = z.boolean();
      break;
    case "date":
      v = z.string().datetime();
      break;
    case "json":
      v = z.record(z.unknown());
      break;
    case "reference":
      v = z.string().uuid();
      break;
    case "enum":
      if (field.enum_values && field.enum_values.length > 0) {
        v = z.enum(field.enum_values as [string, ...string[]]);
      } else {
        v = z.string();
      }
      break;
    case "array": {
      const itemValidator = buildScalarValidator(field.array_item_type ?? "string");
      v = z.array(itemValidator);
      break;
    }
    default:
      v = z.unknown();
  }

  if (field.nullable) v = v.nullable();
  if (!field.required) v = v.optional();
  if (field.default_value !== null && field.default_value !== undefined) {
    v = v.default(field.default_value as never);
  }

  return v;
}

function buildScalarValidator(itemType: string): ZodTypeAny {
  switch (itemType) {
    case "string": return z.string();
    case "number": return z.number();
    case "boolean": return z.boolean();
    case "date": return z.string().datetime();
    case "json": return z.record(z.unknown());
    default: return z.unknown();
  }
}

export function buildEntityZodSchema(fields: FieldRow[]): z.ZodObject<Record<string, ZodTypeAny>> {
  const shape: Record<string, ZodTypeAny> = {
    _id: z.string().uuid(),
    _createdAt: z.string().datetime(),
    _updatedAt: z.string().datetime(),
    _version: z.number().int(),
    _sourceId: z.string().nullable(),
  };

  for (const field of fields) {
    shape[field.slug] = buildFieldZodValidator(field);
  }

  return z.object(shape);
}

export function buildCreateInputSchema(fields: FieldRow[]): z.ZodObject<Record<string, ZodTypeAny>> {
  const shape: Record<string, ZodTypeAny> = {};

  for (const field of fields) {
    shape[field.slug] = buildFieldZodValidator(field);
  }

  return z.object(shape);
}

export function serializeZodSchema(fields: FieldRow[], entityName: string): string {
  const lines: string[] = [];
  lines.push(`export const ${entityName}Schema = z.object({`);
  lines.push(`  _id: z.string().uuid(),`);
  lines.push(`  _createdAt: z.string().datetime(),`);
  lines.push(`  _updatedAt: z.string().datetime(),`);
  lines.push(`  _version: z.number().int(),`);
  lines.push(`  _sourceId: z.string().nullable(),`);

  for (const field of fields) {
    lines.push(`  ${field.slug}: ${serializeFieldValidator(field)},`);
  }

  lines.push(`});`);
  return lines.join("\n");
}

function serializeFieldValidator(field: FieldRow): string {
  const parts: string[] = [];

  switch (field.field_type) {
    case "string": {
      parts.push("z.string()");
      for (const rule of field.validation_rules) {
        switch (rule.type) {
          case "minLength": parts.push(`.min(${rule.value})`); break;
          case "maxLength": parts.push(`.max(${rule.value})`); break;
          case "pattern": parts.push(`.regex(new RegExp(${JSON.stringify(rule.value)}))`); break;
          case "email": parts.push(`.email()`); break;
          case "url": parts.push(`.url()`); break;
        }
      }
      break;
    }
    case "number": {
      parts.push("z.number()");
      for (const rule of field.validation_rules) {
        switch (rule.type) {
          case "min": parts.push(`.min(${rule.value})`); break;
          case "max": parts.push(`.max(${rule.value})`); break;
        }
      }
      break;
    }
    case "boolean": parts.push("z.boolean()"); break;
    case "date": parts.push("z.string().datetime()"); break;
    case "json": parts.push("z.record(z.unknown())"); break;
    case "reference": parts.push("z.string().uuid()"); break;
    case "enum":
      if (field.enum_values && field.enum_values.length > 0) {
        parts.push(`z.enum(${JSON.stringify(field.enum_values)})`);
      } else {
        parts.push("z.string()");
      }
      break;
    case "array": {
      const VALID_ITEM_TYPES = new Set(["string", "number", "boolean"]);
      const itemType = field.array_item_type ?? "string";
      if (!VALID_ITEM_TYPES.has(itemType)) {
        parts.push(`z.array(z.unknown())`);
      } else {
        parts.push(`z.array(z.${itemType}())`);
      }
      break;
    }
    default:
      parts.push("z.unknown()");
  }

  if (field.nullable) parts.push(".nullable()");
  if (!field.required) parts.push(".optional()");

  return parts.join("");
}
