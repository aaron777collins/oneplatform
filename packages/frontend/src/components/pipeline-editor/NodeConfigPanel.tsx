/**
 * NodeConfigPanel — slide-out configuration panel for the selected node.
 *
 * Rendered beside the canvas when a node is selected (double-clicked or via
 * the single-click + configure button path). Displays form fields appropriate
 * for the step type. The Monaco editor is used for code steps.
 *
 * The panel fires onUpdate with the merged config object on every meaningful
 * change so the canvas can immediately reflect label edits.
 */
import * as React from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Textarea } from "@/components/ui/textarea.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils.js";
import { useApiClient } from "@/lib/api-client.js";
import type { GraphNode, StepConfig } from "./graph-model.js";

// ---------------------------------------------------------------------------
// Connector list types (mirrors ConnectorsPage shapes for the picker)
// ---------------------------------------------------------------------------

interface ConnectorRowApi {
  id: string;
  name: string;
  plugin_id: string;
}

interface ConnectorListItem {
  connector: ConnectorRowApi;
}

interface ConnectorListResponse {
  items?: ConnectorListItem[];
  data?: ConnectorListItem[];
}

// Monaco is loaded lazily — it is a heavy dependency and not every user will
// open a code step, so we avoid pulling it into the main bundle.
const MonacoEditor = React.lazy(() =>
  import("@monaco-editor/react").then((m) => ({ default: m.default }))
);

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface NodeConfigPanelProps {
  node: GraphNode;
  onUpdate: (nodeId: string, label: string, config: StepConfig) => void;
  onClose: () => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// NodeConfigPanel
// ---------------------------------------------------------------------------

export function NodeConfigPanel({
  node,
  onUpdate,
  onClose,
  className,
}: NodeConfigPanelProps) {
  const [label, setLabel] = React.useState(node.label);
  const [config, setConfig] = React.useState<StepConfig>({ ...node.config });

  // Reset local state when the selected node changes
  React.useEffect(() => {
    setLabel(node.label);
    setConfig({ ...node.config });
  }, [node.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleLabelChange(value: string) {
    setLabel(value);
    onUpdate(node.id, value, config);
  }

  function handleConfigChange(key: string, value: unknown) {
    const next = { ...config, [key]: value };
    setConfig(next);
    onUpdate(node.id, label, next);
  }

  return (
    <aside
      className={cn(
        "flex h-full w-72 shrink-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-card)]",
        className
      )}
      aria-label="Step configuration"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
        <h2 className="text-sm font-semibold">Configure step</h2>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onClose}
          aria-label="Close configuration panel"
        >
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </div>

      {/* Form */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        {/* Step name — common to all types */}
        <FormField label="Step name" htmlFor="cfg-label">
          <Input
            id="cfg-label"
            value={label}
            onChange={(e) => handleLabelChange(e.target.value)}
            placeholder="Step label"
          />
        </FormField>

        {/* Type-specific fields */}
        <StepTypeFields
          node={node}
          config={config}
          onConfigChange={handleConfigChange}
        />
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Type-specific field sets
// ---------------------------------------------------------------------------

interface StepTypeFieldsProps {
  node: GraphNode;
  config: StepConfig;
  onConfigChange: (key: string, value: unknown) => void;
}

function StepTypeFields({ node, config, onConfigChange }: StepTypeFieldsProps) {
  switch (node.type) {
    case "code":
      return <CodeFields config={config} onConfigChange={onConfigChange} />;
    case "conditional":
      return <ConditionalFields config={config} onConfigChange={onConfigChange} />;
    case "wait":
      return <WaitFields config={config} onConfigChange={onConfigChange} />;
    case "approval":
      return <ApprovalFields config={config} onConfigChange={onConfigChange} />;
    case "webhook":
      return <WebhookFields config={config} onConfigChange={onConfigChange} />;
    case "sub_workflow":
      return <SubWorkflowFields config={config} onConfigChange={onConfigChange} />;
    case "connector":
      return <ConnectorFields config={config} onConfigChange={onConfigChange} />;
    case "transformer":
      return <TransformerFields config={config} onConfigChange={onConfigChange} />;
    case "transform":
      return <TransformFields config={config} onConfigChange={onConfigChange} />;
    default:
      return (
        <p className="text-xs text-[var(--color-muted-foreground)]">
          No additional configuration for this step type.
        </p>
      );
  }
}

// ---------------------------------------------------------------------------
// Code step fields
// ---------------------------------------------------------------------------

function CodeFields({
  config,
  onConfigChange,
}: {
  config: StepConfig;
  onConfigChange: (k: string, v: unknown) => void;
}) {
  const language = (config["language"] as string | undefined) ?? "typescript";

  return (
    <>
      <FormField label="Language" htmlFor="cfg-language">
        <Select
          value={language}
          onValueChange={(v) => onConfigChange("language", v)}
        >
          <SelectTrigger id="cfg-language">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="typescript">TypeScript</SelectItem>
            <SelectItem value="javascript">JavaScript</SelectItem>
            <SelectItem value="python">Python</SelectItem>
            <SelectItem value="go">Go</SelectItem>
          </SelectContent>
        </Select>
      </FormField>

      <FormField label="Code" htmlFor="cfg-code">
        <div className="h-48 w-full overflow-hidden rounded-md border border-[var(--color-border)]">
          <React.Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-xs text-[var(--color-muted-foreground)]">
                Loading editor…
              </div>
            }
          >
            <MonacoEditor
              height="100%"
              language={language}
              value={(config["code"] as string | undefined) ?? ""}
              onChange={(v) => onConfigChange("code", v ?? "")}
              options={{
                minimap: { enabled: false },
                fontSize: 12,
                lineNumbers: "on",
                scrollBeyondLastLine: false,
                automaticLayout: true,
              }}
            />
          </React.Suspense>
        </div>
      </FormField>
    </>
  );
}

// ---------------------------------------------------------------------------
// Conditional step fields
// ---------------------------------------------------------------------------

function ConditionalFields({
  config,
  onConfigChange,
}: {
  config: StepConfig;
  onConfigChange: (k: string, v: unknown) => void;
}) {
  const condition = (config["condition"] as Record<string, unknown> | undefined) ?? {};

  function handleConditionField(key: string, value: unknown) {
    onConfigChange("condition", { ...condition, [key]: value });
  }

  return (
    <>
      <FormField label="Field path" htmlFor="cfg-cond-field">
        <Input
          id="cfg-cond-field"
          placeholder="e.g. data.status"
          value={(condition["field"] as string | undefined) ?? ""}
          onChange={(e) => handleConditionField("field", e.target.value)}
        />
      </FormField>

      <FormField label="Operator" htmlFor="cfg-cond-op">
        <Select
          value={(condition["operator"] as string | undefined) ?? "eq"}
          onValueChange={(v) => handleConditionField("operator", v)}
        >
          <SelectTrigger id="cfg-cond-op">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["eq", "neq", "gt", "gte", "lt", "lte", "contains", "not_contains", "exists", "not_exists", "matches"].map((op) => (
              <SelectItem key={op} value={op}>{op}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>

      <FormField label="Value" htmlFor="cfg-cond-value">
        <Input
          id="cfg-cond-value"
          placeholder="Comparison value"
          value={(condition["value"] as string | undefined) ?? ""}
          onChange={(e) => handleConditionField("value", e.target.value)}
        />
      </FormField>

      <FormField label="Then step ID" htmlFor="cfg-then">
        <Input
          id="cfg-then"
          placeholder="Step ID to run on true"
          value={(config["thenStepId"] as string | undefined) ?? ""}
          onChange={(e) => onConfigChange("thenStepId", e.target.value)}
        />
      </FormField>

      <FormField label="Else step ID (optional)" htmlFor="cfg-else">
        <Input
          id="cfg-else"
          placeholder="Step ID to run on false"
          value={(config["elseStepId"] as string | undefined) ?? ""}
          onChange={(e) => onConfigChange("elseStepId", e.target.value)}
        />
      </FormField>
    </>
  );
}

// ---------------------------------------------------------------------------
// Wait step fields
// ---------------------------------------------------------------------------

function WaitFields({
  config,
  onConfigChange,
}: {
  config: StepConfig;
  onConfigChange: (k: string, v: unknown) => void;
}) {
  const ms = (config["durationMs"] as number | undefined) ?? 0;

  return (
    <FormField label="Duration (ms)" htmlFor="cfg-wait-ms">
      <Input
        id="cfg-wait-ms"
        type="number"
        min={1000}
        max={86_400_000}
        value={ms}
        onChange={(e) => onConfigChange("durationMs", Number(e.target.value))}
        placeholder="e.g. 60000"
      />
      <p className="text-[10px] text-[var(--color-muted-foreground)] mt-1">
        Max 24 hours (86,400,000 ms)
      </p>
    </FormField>
  );
}

// ---------------------------------------------------------------------------
// Approval step fields
// ---------------------------------------------------------------------------

function ApprovalFields({
  config,
  onConfigChange,
}: {
  config: StepConfig;
  onConfigChange: (k: string, v: unknown) => void;
}) {
  const approvers = ((config["approvers"] as string[] | undefined) ?? []).join(", ");

  return (
    <>
      <FormField label="Approvers (comma-separated)" htmlFor="cfg-approvers">
        <Input
          id="cfg-approvers"
          placeholder="user@example.com, admin@example.com"
          value={approvers}
          onChange={(e) =>
            onConfigChange(
              "approvers",
              e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            )
          }
        />
      </FormField>

      <FormField label="Message (optional)" htmlFor="cfg-approval-msg">
        <Textarea
          id="cfg-approval-msg"
          rows={3}
          placeholder="Describe what needs approval"
          value={(config["message"] as string | undefined) ?? ""}
          onChange={(e) => onConfigChange("message", e.target.value)}
        />
      </FormField>
    </>
  );
}

// ---------------------------------------------------------------------------
// Webhook step fields
// ---------------------------------------------------------------------------

function WebhookFields({
  config,
  onConfigChange,
}: {
  config: StepConfig;
  onConfigChange: (k: string, v: unknown) => void;
}) {
  return (
    <>
      <FormField label="URL" htmlFor="cfg-webhook-url">
        <Input
          id="cfg-webhook-url"
          type="url"
          placeholder="https://example.com/hook"
          value={(config["url"] as string | undefined) ?? ""}
          onChange={(e) => onConfigChange("url", e.target.value)}
        />
      </FormField>

      <FormField label="Method" htmlFor="cfg-webhook-method">
        <Select
          value={(config["method"] as string | undefined) ?? "POST"}
          onValueChange={(v) => onConfigChange("method", v)}
        >
          <SelectTrigger id="cfg-webhook-method">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => (
              <SelectItem key={m} value={m}>{m}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sub-workflow step fields
// ---------------------------------------------------------------------------

function SubWorkflowFields({
  config,
  onConfigChange,
}: {
  config: StepConfig;
  onConfigChange: (k: string, v: unknown) => void;
}) {
  return (
    <FormField label="Pipeline ID" htmlFor="cfg-sub-pid">
      <Input
        id="cfg-sub-pid"
        placeholder="UUID of child pipeline"
        value={(config["pipelineId"] as string | undefined) ?? ""}
        onChange={(e) => onConfigChange("pipelineId", e.target.value)}
      />
    </FormField>
  );
}

// ---------------------------------------------------------------------------
// Connector step fields
// ---------------------------------------------------------------------------

function ConnectorFields({
  config,
  onConfigChange,
}: {
  config: StepConfig;
  onConfigChange: (k: string, v: unknown) => void;
}) {
  const client = useApiClient();
  const { data: connectorList, isLoading: connectorsLoading } = useQuery({
    queryKey: ["connectors"],
    queryFn: () => client.get<ConnectorListResponse>("/v1/connectors"),
    staleTime: 60_000,
  });

  const connectors: ConnectorListItem[] =
    connectorList?.items ?? connectorList?.data ?? [];

  const selectedId = (config["connectorInstanceId"] as string | undefined) ?? "";

  return (
    <>
      <FormField label="Connector" htmlFor="cfg-conn-id">
        {connectorsLoading ? (
          <Input id="cfg-conn-id" disabled placeholder="Loading connectors..." />
        ) : connectors.length === 0 ? (
          <>
            <Input
              id="cfg-conn-id"
              placeholder="Connector UUID (no connectors found)"
              value={selectedId}
              onChange={(e) => onConfigChange("connectorInstanceId", e.target.value)}
            />
            <p className="mt-1 text-[10px] text-[var(--color-muted-foreground)]">
              No connectors available. Enter an ID manually or create a connector first.
            </p>
          </>
        ) : (
          <Select
            value={selectedId}
            onValueChange={(v) => onConfigChange("connectorInstanceId", v)}
          >
            <SelectTrigger id="cfg-conn-id">
              <SelectValue placeholder="Select a connector..." />
            </SelectTrigger>
            <SelectContent>
              {connectors.map(({ connector: c }) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name} ({c.plugin_id})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </FormField>

      <FormField label="Sync mode" htmlFor="cfg-sync-mode">
        <Select
          value={(config["syncMode"] as string | undefined) ?? "full"}
          onValueChange={(v) => onConfigChange("syncMode", v)}
        >
          <SelectTrigger id="cfg-sync-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="full">Full</SelectItem>
            <SelectItem value="incremental">Incremental</SelectItem>
          </SelectContent>
        </Select>
      </FormField>
    </>
  );
}

// ---------------------------------------------------------------------------
// Transformer step fields
// ---------------------------------------------------------------------------

function TransformerFields({
  config,
  onConfigChange,
}: {
  config: StepConfig;
  onConfigChange: (k: string, v: unknown) => void;
}) {
  return (
    <FormField label="Transformer ID" htmlFor="cfg-transformer-id">
      <Input
        id="cfg-transformer-id"
        placeholder="Registered transformer plugin ID"
        value={(config["transformerId"] as string | undefined) ?? ""}
        onChange={(e) => onConfigChange("transformerId", e.target.value)}
      />
    </FormField>
  );
}

// ---------------------------------------------------------------------------
// Transform (declarative) step fields
// ---------------------------------------------------------------------------

function TransformFields({
  config,
  onConfigChange,
}: {
  config: StepConfig;
  onConfigChange: (k: string, v: unknown) => void;
}) {
  const transform = (config["transform"] as Record<string, unknown> | undefined) ?? {};
  const operation = (transform["operation"] as string | undefined) ?? "filter";

  // Extract params (everything except "operation") for the JSON textarea.
  const { operation: _op, ...params } = transform;
  const [paramsText, setParamsText] = React.useState(() =>
    Object.keys(params).length > 0 ? JSON.stringify(params, null, 2) : "",
  );
  const [parseError, setParseError] = React.useState<string | null>(null);

  const handleOperationChange = React.useCallback(
    (v: string) => {
      // Merge new operation with existing params.
      try {
        const parsed = paramsText.trim() ? JSON.parse(paramsText) : {};
        onConfigChange("transform", { ...parsed, operation: v });
      } catch {
        onConfigChange("transform", { operation: v });
      }
    },
    [paramsText, onConfigChange],
  );

  const handleParamsBlur = React.useCallback(() => {
    const trimmed = paramsText.trim();
    if (trimmed === "") {
      setParseError(null);
      onConfigChange("transform", { operation });
      return;
    }
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      setParseError(null);
      onConfigChange("transform", { ...parsed, operation });
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Invalid JSON");
    }
  }, [paramsText, operation, onConfigChange]);

  return (
    <>
      <FormField label="Operation" htmlFor="cfg-transform-op">
        <Select
          value={operation}
          onValueChange={handleOperationChange}
        >
          <SelectTrigger id="cfg-transform-op">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["dedup", "filter", "map", "aggregate", "pivot", "unpivot", "join", "sort", "limit", "rename"].map((op) => (
              <SelectItem key={op} value={op}>{op}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>

      <FormField label="Parameters (JSON)" htmlFor="cfg-transform-params">
        <Textarea
          id="cfg-transform-params"
          className="font-mono text-xs"
          rows={6}
          placeholder={'{\n  "field": "status",\n  "equals": "active"\n}'}
          value={paramsText}
          onChange={(e) => {
            setParamsText(e.target.value);
            if (parseError) setParseError(null);
          }}
          onBlur={handleParamsBlur}
        />
        {parseError !== null && (
          <p className="mt-1 text-[11px] text-[var(--color-destructive)]">{parseError}</p>
        )}
      </FormField>

      <p className="text-[10px] text-[var(--color-muted-foreground)]">
        Enter operation-specific parameters as a JSON object. Changes apply on blur.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// FormField wrapper
// ---------------------------------------------------------------------------

function FormField({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor} className="text-xs font-medium">
        {label}
      </Label>
      {children}
    </div>
  );
}
