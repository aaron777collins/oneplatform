/**
 * PluginConfigForm — dynamic form generated from a plugin manifest's configSchema.
 *
 * Mirrors ConnectorForm but for plugin instance configuration. The same
 * JSON Schema subset (string, number, boolean, enum) is supported.
 */
import * as React from "react";
import { ConnectorForm, type ConnectorConfigSchema, type ConnectorFormValues } from "@/components/connectors/ConnectorForm.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { ConnectorConfigSchema as PluginConfigSchema, ConnectorFormValues as PluginConfigValues };

export interface PluginConfigFormProps {
  schema: ConnectorConfigSchema;
  defaultValues?: ConnectorFormValues;
  onSubmit: (values: ConnectorFormValues) => void | Promise<void>;
  isSubmitting?: boolean;
  submitLabel?: string;
  className?: string;
}

// ---------------------------------------------------------------------------
// PluginConfigForm component
// ---------------------------------------------------------------------------

/**
 * PluginConfigForm delegates to ConnectorForm because the JSON Schema config
 * rendering logic is identical. The naming distinction exists at the semantic
 * level (plugin vs connector configuration) but the form structure is the same.
 */
export function PluginConfigForm({
  schema,
  defaultValues,
  onSubmit,
  isSubmitting,
  submitLabel = "Save config",
  className,
}: PluginConfigFormProps) {
  return (
    <ConnectorForm
      schema={schema}
      {...(defaultValues !== undefined ? { defaultValues } : {})}
      onSubmit={onSubmit}
      {...(isSubmitting !== undefined ? { isSubmitting } : {})}
      submitLabel={submitLabel}
      {...(className !== undefined ? { className } : {})}
    />
  );
}
