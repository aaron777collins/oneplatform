/**
 * ConnectorForm — dynamic form generated from a connector's JSON Schema config.
 *
 * Each field in configSchema.properties becomes a form control. Supported
 * JSON Schema field types: string, number, boolean, and enums (select).
 * Password fields are detected by the "format": "password" annotation or
 * by field names matching common password patterns (password, secret, token, key).
 *
 * Form state is owned by react-hook-form. Validation uses Zod schemas built
 * dynamically from the JSON Schema property definitions.
 */
import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Eye, EyeOff, HelpCircle } from "lucide-react";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Button } from "@/components/ui/button.js";
import { cn } from "@/lib/utils.js";

// ---------------------------------------------------------------------------
// JSON Schema types (subset used for connector config)
// ---------------------------------------------------------------------------

export interface JsonSchemaProperty {
  type?: "string" | "number" | "integer" | "boolean";
  title?: string;
  description?: string;
  /** format: "password" marks the field as a secret input */
  format?: string;
  enum?: string[];
  default?: string | number | boolean;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  /** Example values shown as inline hints below the field. */
  examples?: Array<string | number | boolean>;
}

export interface ConnectorConfigSchema {
  type: "object";
  required?: string[];
  properties: Record<string, JsonSchemaProperty>;
}

export type ConnectorFormValues = Record<string, string | number | boolean>;

export interface ConnectorFormProps {
  schema: ConnectorConfigSchema;
  /** Existing values for edit mode. Omit for create mode. */
  defaultValues?: ConnectorFormValues;
  onSubmit: (values: ConnectorFormValues) => void | Promise<void>;
  isSubmitting?: boolean;
  submitLabel?: string;
  className?: string;
}

// ---------------------------------------------------------------------------
// Zod schema builder
// ---------------------------------------------------------------------------

function buildZodSchema(schema: ConnectorConfigSchema): z.ZodObject<z.ZodRawShape> {
  const shape: z.ZodRawShape = {};
  const required = new Set(schema.required ?? []);

  for (const [key, prop] of Object.entries(schema.properties)) {
    const isRequired = required.has(key);
    let field: z.ZodTypeAny;

    if (prop.type === "boolean") {
      field = z.boolean();
    } else if (prop.type === "number" || prop.type === "integer") {
      let numField = z.number();
      if (prop.minimum !== undefined) numField = numField.min(prop.minimum);
      if (prop.maximum !== undefined) numField = numField.max(prop.maximum);
      field = isRequired ? numField : numField.optional();
    } else if (prop.enum !== undefined) {
      const [first, ...rest] = prop.enum;
      if (first === undefined) {
        field = z.string();
      } else {
        field = z.enum([first, ...rest] as [string, ...string[]]);
      }
    } else {
      // default: string
      let strField = z.string();
      if (prop.minLength !== undefined) strField = strField.min(prop.minLength);
      if (prop.maxLength !== undefined) strField = strField.max(prop.maxLength);
      if (isRequired) strField = strField.min(1, `${prop.title ?? key} is required`);
      field = isRequired ? strField : strField.optional();
    }

    shape[key] = field;
  }

  return z.object(shape);
}

// ---------------------------------------------------------------------------
// Helper: detect password fields
// ---------------------------------------------------------------------------

const PASSWORD_PATTERNS = /\b(password|secret|api[_-]?key|token|credential)\b/i;

function isPasswordField(key: string, prop: JsonSchemaProperty): boolean {
  return prop.format === "password" || PASSWORD_PATTERNS.test(key);
}

// ---------------------------------------------------------------------------
// Field hint — tooltip icon + inline examples
// ---------------------------------------------------------------------------

function FieldHint({ prop }: { prop: JsonSchemaProperty }) {
  const hasExamples = prop.examples !== undefined && prop.examples.length > 0;
  if (!prop.description && !hasExamples) return null;

  return (
    <>
      {prop.description !== undefined && (
        <span
          className="group relative ml-1 inline-flex cursor-help"
          aria-label={prop.description}
        >
          <HelpCircle className="h-3.5 w-3.5 text-[var(--color-muted-foreground)]" aria-hidden />
          <span
            role="tooltip"
            className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded bg-[var(--color-popover)] px-2 py-1 text-xs text-[var(--color-popover-foreground)] opacity-0 shadow-md transition-opacity group-hover:opacity-100"
          >
            {prop.description}
          </span>
        </span>
      )}
      {hasExamples && (
        <FormDescription>
          e.g. {prop.examples!.map(String).join(", ")}
        </FormDescription>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Individual field renderer
// ---------------------------------------------------------------------------

interface FieldRendererProps {
  fieldKey: string;
  prop: JsonSchemaProperty;
  isRequired: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  control: any;
}

function FieldRenderer({ fieldKey, prop, isRequired, control }: FieldRendererProps) {
  const [showPassword, setShowPassword] = React.useState(false);
  const label = prop.title ?? fieldKey;
  const isPassword = isPasswordField(fieldKey, prop);

  if (prop.type === "boolean") {
    return (
      <FormField
        control={control}
        name={fieldKey}
        render={({ field }) => (
          <FormItem className="flex flex-row items-center gap-3 space-y-0">
            <FormControl>
              <input
                type="checkbox"
                id={field.name}
                checked={field.value as boolean | undefined ?? false}
                onChange={field.onChange}
                className="h-4 w-4 rounded border-[var(--color-input)] accent-[var(--color-primary)]"
              />
            </FormControl>
            <div>
              <FormLabel>{label}<FieldHint prop={prop} /></FormLabel>
            </div>
          </FormItem>
        )}
      />
    );
  }

  if (prop.enum !== undefined) {
    return (
      <FormField
        control={control}
        name={fieldKey}
        render={({ field }) => (
          <FormItem>
            <FormLabel>
              {label}
              {isRequired && <span className="ml-1 text-[var(--color-destructive)]" aria-hidden>*</span>}
              <FieldHint prop={prop} />
            </FormLabel>
            <Select
              onValueChange={field.onChange}
              value={typeof field.value === "string" ? field.value : ""}
            >
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder={`Select ${label.toLowerCase()}`} />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {prop.enum!.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {opt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )}
      />
    );
  }

  if (prop.type === "number" || prop.type === "integer") {
    return (
      <FormField
        control={control}
        name={fieldKey}
        render={({ field }) => (
          <FormItem>
            <FormLabel>
              {label}
              {isRequired && <span className="ml-1 text-[var(--color-destructive)]" aria-hidden>*</span>}
              <FieldHint prop={prop} />
            </FormLabel>
            <FormControl>
              <Input
                type="number"
                placeholder={prop.examples !== undefined && prop.examples.length > 0 ? `e.g. ${String(prop.examples[0])}` : (prop.description ?? label)}
                {...field}
                onChange={(e) => field.onChange(parseFloat(e.target.value))}
                value={typeof field.value === "number" ? field.value : ""}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    );
  }

  // Default: text / password
  return (
    <FormField
      control={control}
      name={fieldKey}
      render={({ field }) => (
        <FormItem>
          <FormLabel>
            {label}
            {isRequired && <span className="ml-1 text-[var(--color-destructive)]" aria-hidden>*</span>}
            <FieldHint prop={prop} />
          </FormLabel>
          <FormControl>
            <div className="relative">
              <Input
                type={isPassword && !showPassword ? "password" : "text"}
                placeholder={prop.examples !== undefined && prop.examples.length > 0 ? `e.g. ${String(prop.examples[0])}` : (prop.description ?? label)}
                autoComplete={isPassword ? "new-password" : "off"}
                {...field}
                value={typeof field.value === "string" ? field.value : ""}
                className={cn(isPassword && "pr-10")}
              />
              {isPassword && (
                <button
                  type="button"
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
                  onClick={() => setShowPassword((v) => !v)}
                  aria-label={showPassword ? "Hide field" : "Show field"}
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" aria-hidden />
                  ) : (
                    <Eye className="h-4 w-4" aria-hidden />
                  )}
                </button>
              )}
            </div>
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// ConnectorForm component
// ---------------------------------------------------------------------------

export function ConnectorForm({
  schema,
  defaultValues,
  onSubmit,
  isSubmitting = false,
  submitLabel = "Save",
  className,
}: ConnectorFormProps) {
  const zodSchema = React.useMemo(() => buildZodSchema(schema), [schema]);
  const required = new Set(schema.required ?? []);

  const form = useForm<ConnectorFormValues>({
    resolver: zodResolver(zodSchema),
    ...(defaultValues !== undefined ? { defaultValues } : {}),
  });

  async function handleSubmit(values: ConnectorFormValues) {
    await onSubmit(values);
  }

  const propertyEntries = Object.entries(schema.properties);

  return (
    <Form {...form}>
      <form
        onSubmit={(e) => void form.handleSubmit(handleSubmit)(e)}
        className={cn("space-y-4", className)}
        noValidate
      >
        {propertyEntries.map(([key, prop]) => (
          <FieldRenderer
            key={key}
            fieldKey={key}
            prop={prop}
            isRequired={required.has(key)}
            control={form.control}
          />
        ))}

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
    </Form>
  );
}
