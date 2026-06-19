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
import { X, Check, ChevronDown } from "lucide-react";
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs.js";
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
  /** All nodes in the graph — used by conditional step to list available targets */
  allNodes?: GraphNode[] | undefined;
  onUpdate: (nodeId: string, label: string, config: StepConfig) => void;
  onClose: () => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// NodeConfigPanel
// ---------------------------------------------------------------------------

export function NodeConfigPanel({
  node,
  allNodes,
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
          allNodes={allNodes}
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
  allNodes?: GraphNode[] | undefined;
  config: StepConfig;
  onConfigChange: (key: string, value: unknown) => void;
}

function StepTypeFields({ node, allNodes, config, onConfigChange }: StepTypeFieldsProps) {
  switch (node.type) {
    case "code":
      return <CodeFields config={config} onConfigChange={onConfigChange} />;
    case "conditional":
      return <ConditionalFields config={config} onConfigChange={onConfigChange} currentNodeId={node.id} allNodes={allNodes} />;
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

// ---------------------------------------------------------------------------
// Code step templates
// ---------------------------------------------------------------------------

interface CodeTemplate {
  id: string;
  title: string;
  description: string;
  language: string;
  /** Template code with {{placeholder}} markers */
  code: string;
  /** Parameters the user can fill in via form inputs */
  params: { key: string; label: string; placeholder: string }[];
}

const CODE_TEMPLATES: CodeTemplate[] = [
  {
    id: "filter-records",
    title: "Filter records",
    description: "Keep only records matching a field condition",
    language: "typescript",
    code: `// Filter records where {{field}} {{operator}} {{value}}
export default function transform(records: any[]) {
  return records.filter((r) => {
    const val = r["{{field}}"];
    const target = "{{value}}";
    switch ("{{operator}}") {
      case "equals": return String(val) === target;
      case "contains": return String(val).includes(target);
      case "greater_than": return Number(val) > Number(target);
      case "less_than": return Number(val) < Number(target);
      default: return true;
    }
  });
}`,
    params: [
      { key: "field", label: "Field name", placeholder: "e.g. status" },
      { key: "operator", label: "Operator", placeholder: "equals" },
      { key: "value", label: "Value", placeholder: "e.g. active" },
    ],
  },
  {
    id: "map-fields",
    title: "Map fields",
    description: "Rename or transform field values in each record",
    language: "typescript",
    code: `// Map: rename "{{sourceField}}" to "{{targetField}}"
export default function transform(records: any[]) {
  return records.map((r) => {
    const { ["{{sourceField}}"]: value, ...rest } = r;
    return { ...rest, ["{{targetField}}"]: value };
  });
}`,
    params: [
      { key: "sourceField", label: "Source field", placeholder: "e.g. first_name" },
      { key: "targetField", label: "Target field", placeholder: "e.g. firstName" },
    ],
  },
  {
    id: "aggregate-data",
    title: "Aggregate data",
    description: "Group records and calculate summary values",
    language: "typescript",
    code: `// Aggregate: {{function}} grouped by "{{groupByField}}"
export default function transform(records: any[]) {
  const groups: Record<string, any[]> = {};
  for (const r of records) {
    const key = String(r["{{groupByField}}"] ?? "unknown");
    (groups[key] ??= []).push(r);
  }
  return Object.entries(groups).map(([key, items]) => ({
    ["{{groupByField}}"]: key,
    count: items.length,
    // Add more aggregations as needed
  }));
}`,
    params: [
      { key: "groupByField", label: "Group by field", placeholder: "e.g. category" },
      { key: "function", label: "Function", placeholder: "count" },
    ],
  },
  {
    id: "enrich-data",
    title: "Enrich data",
    description: "Add computed fields to each record",
    language: "typescript",
    code: `// Enrich: add "{{newField}}" computed from "{{sourceField}}"
export default function transform(records: any[]) {
  return records.map((r) => ({
    ...r,
    ["{{newField}}"]: String(r["{{sourceField}}"] ?? "").toUpperCase(),
  }));
}`,
    params: [
      { key: "sourceField", label: "Source field", placeholder: "e.g. name" },
      { key: "newField", label: "New field name", placeholder: "e.g. name_upper" },
    ],
  },
];

function CodeFields({
  config,
  onConfigChange,
}: {
  config: StepConfig;
  onConfigChange: (k: string, v: unknown) => void;
}) {
  const language = (config["language"] as string | undefined) ?? "typescript";
  const code = (config["code"] as string | undefined) ?? "";
  const [activeTab, setActiveTab] = React.useState<string>(code ? "custom" : "templates");
  const [selectedTemplate, setSelectedTemplate] = React.useState<string | null>(null);
  const [templateParams, setTemplateParams] = React.useState<Record<string, string>>({});

  function applyTemplate(tmpl: CodeTemplate) {
    let generated = tmpl.code;
    for (const p of tmpl.params) {
      const val = templateParams[p.key] ?? p.placeholder;
      generated = generated.replaceAll(`{{${p.key}}}`, val);
    }
    onConfigChange("language", tmpl.language);
    onConfigChange("code", generated);
    setActiveTab("custom");
  }

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

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="w-full">
          <TabsTrigger value="templates" className="flex-1 text-xs">Templates</TabsTrigger>
          <TabsTrigger value="custom" className="flex-1 text-xs">Custom code</TabsTrigger>
        </TabsList>

        <TabsContent value="templates">
          <div className="space-y-2">
            {CODE_TEMPLATES.map((tmpl) => (
              <button
                key={tmpl.id}
                type="button"
                className={cn(
                  "w-full rounded-md border p-2.5 text-left transition-colors",
                  selectedTemplate === tmpl.id
                    ? "border-[var(--color-primary)] bg-[var(--color-primary)]/5"
                    : "border-[var(--color-border)] hover:border-[var(--color-primary)]/50",
                )}
                onClick={() => {
                  setSelectedTemplate(tmpl.id);
                  setTemplateParams({});
                }}
              >
                <p className="text-xs font-medium">{tmpl.title}</p>
                <p className="text-[10px] text-[var(--color-muted-foreground)] mt-0.5">
                  {tmpl.description}
                </p>
              </button>
            ))}
          </div>

          {/* Parameter form for selected template */}
          {selectedTemplate !== null && (() => {
            const tmpl = CODE_TEMPLATES.find((t) => t.id === selectedTemplate);
            if (!tmpl) return null;
            return (
              <div className="mt-3 space-y-2 rounded-md border border-[var(--color-border)] p-3">
                <p className="text-xs font-medium mb-2">Configure: {tmpl.title}</p>
                {tmpl.params.map((p) => (
                  <div key={p.key} className="space-y-1">
                    <Label htmlFor={`tmpl-${p.key}`} className="text-[11px]">{p.label}</Label>
                    <Input
                      id={`tmpl-${p.key}`}
                      className="h-8 text-xs"
                      placeholder={p.placeholder}
                      value={templateParams[p.key] ?? ""}
                      onChange={(e) =>
                        setTemplateParams((prev) => ({ ...prev, [p.key]: e.target.value }))
                      }
                    />
                  </div>
                ))}
                <Button
                  size="sm"
                  className="w-full mt-2 h-8 text-xs"
                  onClick={() => applyTemplate(tmpl)}
                >
                  <Check className="h-3 w-3 mr-1" aria-hidden />
                  Use template
                </Button>
              </div>
            );
          })()}
        </TabsContent>

        <TabsContent value="custom">
          <div className="h-48 w-full overflow-hidden rounded-md border border-[var(--color-border)]">
            <React.Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-xs text-[var(--color-muted-foreground)]">
                  Loading editor...
                </div>
              }
            >
              <MonacoEditor
                height="100%"
                language={language}
                value={code}
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
        </TabsContent>
      </Tabs>
    </>
  );
}

// ---------------------------------------------------------------------------
// Conditional step fields
// ---------------------------------------------------------------------------

// Human-readable operator labels for condition fields
const OPERATOR_LABELS: Record<string, string> = {
  eq: "equals",
  neq: "does not equal",
  gt: "greater than",
  gte: "at least",
  lt: "less than",
  lte: "at most",
  contains: "contains",
  not_contains: "does not contain",
  exists: "exists",
  not_exists: "does not exist",
  matches: "matches pattern",
  startsWith: "starts with",
};

const OPERATOR_VALUES = Object.keys(OPERATOR_LABELS);

function ConditionalFields({
  config,
  onConfigChange,
  currentNodeId,
  allNodes,
}: {
  config: StepConfig;
  onConfigChange: (k: string, v: unknown) => void;
  currentNodeId: string;
  allNodes?: GraphNode[] | undefined;
}) {
  const condition = (config["condition"] as Record<string, unknown> | undefined) ?? {};

  function handleConditionField(key: string, value: unknown) {
    onConfigChange("condition", { ...condition, [key]: value });
  }

  // Filter out the current node from the target step list
  const availableNodes = (allNodes ?? []).filter((n) => n.id !== currentNodeId);
  const hasAvailableNodes = availableNodes.length > 0;

  return (
    <>
      <FormField label="Field path" htmlFor="cfg-cond-field">
        <Input
          id="cfg-cond-field"
          placeholder="e.g. data.status or output.count"
          value={(condition["field"] as string | undefined) ?? ""}
          onChange={(e) => handleConditionField("field", e.target.value)}
        />
        <p className="text-[10px] text-[var(--color-muted-foreground)] mt-1">
          Dot-notation path to the field to check (e.g. data.user.role)
        </p>
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
            {OPERATOR_VALUES.map((op) => (
              <SelectItem key={op} value={op}>{OPERATOR_LABELS[op]}</SelectItem>
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

      <FormField label="If true, go to" htmlFor="cfg-then">
        {hasAvailableNodes ? (
          <Select
            value={(config["thenStepId"] as string | undefined) ?? ""}
            onValueChange={(v) => onConfigChange("thenStepId", v)}
          >
            <SelectTrigger id="cfg-then">
              <SelectValue placeholder="Select a step..." />
            </SelectTrigger>
            <SelectContent>
              {availableNodes.map((n) => (
                <SelectItem key={n.id} value={n.id}>
                  {n.label || `${n.type} (${n.id.slice(0, 8)})`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            id="cfg-then"
            placeholder="Step ID (add more steps first)"
            value={(config["thenStepId"] as string | undefined) ?? ""}
            onChange={(e) => onConfigChange("thenStepId", e.target.value)}
          />
        )}
      </FormField>

      <FormField label="If false, go to (optional)" htmlFor="cfg-else">
        {hasAvailableNodes ? (
          <Select
            value={(config["elseStepId"] as string | undefined) ?? "__none__"}
            onValueChange={(v) => onConfigChange("elseStepId", v === "__none__" ? "" : v)}
          >
            <SelectTrigger id="cfg-else">
              <SelectValue placeholder="None (skip)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">None (skip)</SelectItem>
              {availableNodes.map((n) => (
                <SelectItem key={n.id} value={n.id}>
                  {n.label || `${n.type} (${n.id.slice(0, 8)})`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            id="cfg-else"
            placeholder="Step ID (optional)"
            value={(config["elseStepId"] as string | undefined) ?? ""}
            onChange={(e) => onConfigChange("elseStepId", e.target.value)}
          />
        )}
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
  const totalMs = (config["durationMs"] as number | undefined) ?? 0;

  // Decompose ms into hours, minutes, seconds
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const seconds = Math.floor((totalMs % 60_000) / 1_000);

  function handleDurationChange(h: number, m: number, s: number) {
    const ms = Math.min(
      Math.max(0, h * 3_600_000 + m * 60_000 + s * 1_000),
      86_400_000,
    );
    onConfigChange("durationMs", ms);
  }

  return (
    <FormField label="Duration" htmlFor="cfg-wait-hours">
      <div className="flex items-center gap-1.5">
        <div className="flex-1">
          <Label htmlFor="cfg-wait-hours" className="text-[10px] text-[var(--color-muted-foreground)] block mb-0.5">
            Hours
          </Label>
          <Input
            id="cfg-wait-hours"
            type="number"
            min={0}
            max={24}
            value={hours}
            onChange={(e) => handleDurationChange(Number(e.target.value) || 0, minutes, seconds)}
            className="h-8 text-xs"
          />
        </div>
        <span className="mt-4 text-xs text-[var(--color-muted-foreground)]">:</span>
        <div className="flex-1">
          <Label htmlFor="cfg-wait-minutes" className="text-[10px] text-[var(--color-muted-foreground)] block mb-0.5">
            Minutes
          </Label>
          <Input
            id="cfg-wait-minutes"
            type="number"
            min={0}
            max={59}
            value={minutes}
            onChange={(e) => handleDurationChange(hours, Number(e.target.value) || 0, seconds)}
            className="h-8 text-xs"
          />
        </div>
        <span className="mt-4 text-xs text-[var(--color-muted-foreground)]">:</span>
        <div className="flex-1">
          <Label htmlFor="cfg-wait-seconds" className="text-[10px] text-[var(--color-muted-foreground)] block mb-0.5">
            Seconds
          </Label>
          <Input
            id="cfg-wait-seconds"
            type="number"
            min={0}
            max={59}
            value={seconds}
            onChange={(e) => handleDurationChange(hours, minutes, Number(e.target.value) || 0)}
            className="h-8 text-xs"
          />
        </div>
      </div>
      <p className="text-[10px] text-[var(--color-muted-foreground)] mt-1">
        Max 24 hours. Current: {totalMs.toLocaleString()} ms
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

interface PipelineSummary {
  id: string;
  name: string;
}

function SubWorkflowFields({
  config,
  onConfigChange,
}: {
  config: StepConfig;
  onConfigChange: (k: string, v: unknown) => void;
}) {
  const client = useApiClient();
  const [searchTerm, setSearchTerm] = React.useState("");
  const { data: pipelineListData, isLoading: pipelinesLoading } = useQuery({
    queryKey: ["pipelines", "sub-workflow-picker"],
    queryFn: () => client.get<{ data: PipelineSummary[] }>("/v1/pipelines"),
    staleTime: 60_000,
  });

  const pipelines: PipelineSummary[] = pipelineListData?.data ?? [];
  const filteredPipelines = searchTerm
    ? pipelines.filter((p) => p.name.toLowerCase().includes(searchTerm.toLowerCase()))
    : pipelines;

  const selectedId = (config["pipelineId"] as string | undefined) ?? "";
  const selectedName = pipelines.find((p) => p.id === selectedId)?.name;

  return (
    <FormField label="Sub-workflow pipeline" htmlFor="cfg-sub-pid">
      {pipelinesLoading ? (
        <Input id="cfg-sub-pid" disabled placeholder="Loading pipelines..." />
      ) : pipelines.length === 0 ? (
        <>
          <Input
            id="cfg-sub-pid"
            placeholder="Pipeline UUID (no pipelines found)"
            value={selectedId}
            onChange={(e) => onConfigChange("pipelineId", e.target.value)}
          />
          <p className="mt-1 text-[10px] text-[var(--color-muted-foreground)]">
            No pipelines available. Create a pipeline first or enter an ID manually.
          </p>
        </>
      ) : (
        <>
          <Input
            id="cfg-sub-pid-search"
            placeholder="Search pipelines..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="mb-1.5 h-7 text-xs"
          />
          <Select
            value={selectedId}
            onValueChange={(v) => onConfigChange("pipelineId", v)}
          >
            <SelectTrigger id="cfg-sub-pid">
              <SelectValue placeholder="Select a pipeline...">
                {selectedName ?? "Select a pipeline..."}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {filteredPipelines.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
              {filteredPipelines.length === 0 && (
                <div className="px-2 py-1.5 text-xs text-[var(--color-muted-foreground)]">
                  No matching pipelines
                </div>
              )}
            </SelectContent>
          </Select>
        </>
      )}
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

interface TransformerPlugin {
  id: string;
  name: string;
  type?: string;
}

function TransformerFields({
  config,
  onConfigChange,
}: {
  config: StepConfig;
  onConfigChange: (k: string, v: unknown) => void;
}) {
  const client = useApiClient();
  const { data: pluginListData, isLoading: pluginsLoading } = useQuery({
    queryKey: ["plugins", "transformers"],
    queryFn: () => client.get<{ data: TransformerPlugin[] }>("/v1/plugins", { type: "transformer" }),
    staleTime: 60_000,
  });

  const plugins: TransformerPlugin[] = pluginListData?.data ?? [];
  const selectedId = (config["transformerId"] as string | undefined) ?? "";

  return (
    <FormField label="Transformer plugin" htmlFor="cfg-transformer-id">
      {pluginsLoading ? (
        <Input id="cfg-transformer-id" disabled placeholder="Loading transformer plugins..." />
      ) : plugins.length === 0 ? (
        <>
          <Input
            id="cfg-transformer-id"
            placeholder="Transformer plugin ID (none found)"
            value={selectedId}
            onChange={(e) => onConfigChange("transformerId", e.target.value)}
          />
          <p className="mt-1 text-[10px] text-[var(--color-muted-foreground)]">
            No transformer plugins available. Install a plugin first or enter an ID manually.
          </p>
        </>
      ) : (
        <Select
          value={selectedId}
          onValueChange={(v) => onConfigChange("transformerId", v)}
        >
          <SelectTrigger id="cfg-transformer-id">
            <SelectValue placeholder="Select a transformer..." />
          </SelectTrigger>
          <SelectContent>
            {plugins.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </FormField>
  );
}

// ---------------------------------------------------------------------------
// Transform (declarative) step fields
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Visual form builders for common transform operations
// ---------------------------------------------------------------------------

const FILTER_OPERATORS = [
  { value: "equals", label: "equals" },
  { value: "not_equals", label: "does not equal" },
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "does not contain" },
  { value: "gt", label: "greater than" },
  { value: "gte", label: "at least" },
  { value: "lt", label: "less than" },
  { value: "lte", label: "at most" },
  { value: "exists", label: "exists" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with", label: "ends with" },
];

const AGGREGATE_FUNCTIONS = [
  { value: "count", label: "Count" },
  { value: "sum", label: "Sum" },
  { value: "avg", label: "Average" },
  { value: "min", label: "Minimum" },
  { value: "max", label: "Maximum" },
];

function FilterForm({
  params,
  onChange,
}: {
  params: Record<string, unknown>;
  onChange: (p: Record<string, unknown>) => void;
}) {
  return (
    <>
      <FormField label="Field" htmlFor="cfg-tf-filter-field">
        <Input
          id="cfg-tf-filter-field"
          placeholder="e.g. status"
          value={(params["field"] as string) ?? ""}
          onChange={(e) => onChange({ ...params, field: e.target.value })}
        />
      </FormField>
      <FormField label="Condition" htmlFor="cfg-tf-filter-op">
        <Select
          value={(params["operator"] as string) ?? "equals"}
          onValueChange={(v) => onChange({ ...params, operator: v })}
        >
          <SelectTrigger id="cfg-tf-filter-op">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FILTER_OPERATORS.map((op) => (
              <SelectItem key={op.value} value={op.value}>{op.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      <FormField label="Value" htmlFor="cfg-tf-filter-val">
        <Input
          id="cfg-tf-filter-val"
          placeholder="e.g. active"
          value={(params["value"] as string) ?? ""}
          onChange={(e) => onChange({ ...params, value: e.target.value })}
        />
      </FormField>
    </>
  );
}

function SortForm({
  params,
  onChange,
}: {
  params: Record<string, unknown>;
  onChange: (p: Record<string, unknown>) => void;
}) {
  return (
    <>
      <FormField label="Sort by field" htmlFor="cfg-tf-sort-field">
        <Input
          id="cfg-tf-sort-field"
          placeholder="e.g. created_at"
          value={(params["field"] as string) ?? ""}
          onChange={(e) => onChange({ ...params, field: e.target.value })}
        />
      </FormField>
      <FormField label="Direction" htmlFor="cfg-tf-sort-dir">
        <Select
          value={(params["direction"] as string) ?? "asc"}
          onValueChange={(v) => onChange({ ...params, direction: v })}
        >
          <SelectTrigger id="cfg-tf-sort-dir">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="asc">Ascending (A to Z, 0 to 9)</SelectItem>
            <SelectItem value="desc">Descending (Z to A, 9 to 0)</SelectItem>
          </SelectContent>
        </Select>
      </FormField>
    </>
  );
}

function AggregateForm({
  params,
  onChange,
}: {
  params: Record<string, unknown>;
  onChange: (p: Record<string, unknown>) => void;
}) {
  return (
    <>
      <FormField label="Group by field" htmlFor="cfg-tf-agg-group">
        <Input
          id="cfg-tf-agg-group"
          placeholder="e.g. category"
          value={(params["groupBy"] as string) ?? ""}
          onChange={(e) => onChange({ ...params, groupBy: e.target.value })}
        />
      </FormField>
      <FormField label="Function" htmlFor="cfg-tf-agg-fn">
        <Select
          value={(params["function"] as string) ?? "count"}
          onValueChange={(v) => onChange({ ...params, function: v })}
        >
          <SelectTrigger id="cfg-tf-agg-fn">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {AGGREGATE_FUNCTIONS.map((fn) => (
              <SelectItem key={fn.value} value={fn.value}>{fn.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>
      <FormField label="Value field (for sum/avg/min/max)" htmlFor="cfg-tf-agg-val">
        <Input
          id="cfg-tf-agg-val"
          placeholder="e.g. amount"
          value={(params["valueField"] as string) ?? ""}
          onChange={(e) => onChange({ ...params, valueField: e.target.value })}
        />
      </FormField>
    </>
  );
}

function RenameForm({
  params,
  onChange,
}: {
  params: Record<string, unknown>;
  onChange: (p: Record<string, unknown>) => void;
}) {
  return (
    <>
      <FormField label="Source field" htmlFor="cfg-tf-rename-src">
        <Input
          id="cfg-tf-rename-src"
          placeholder="e.g. first_name"
          value={(params["sourceField"] as string) ?? ""}
          onChange={(e) => onChange({ ...params, sourceField: e.target.value })}
        />
      </FormField>
      <FormField label="New name" htmlFor="cfg-tf-rename-tgt">
        <Input
          id="cfg-tf-rename-tgt"
          placeholder="e.g. firstName"
          value={(params["targetField"] as string) ?? ""}
          onChange={(e) => onChange({ ...params, targetField: e.target.value })}
        />
      </FormField>
    </>
  );
}

/** Operations that have a dedicated visual form */
const VISUAL_OPERATIONS = new Set(["filter", "sort", "aggregate", "rename", "map"]);

const OPERATION_LABELS: Record<string, string> = {
  dedup: "Remove duplicates",
  filter: "Filter",
  map: "Map / Rename",
  aggregate: "Aggregate",
  pivot: "Pivot",
  unpivot: "Unpivot",
  join: "Join",
  sort: "Sort",
  limit: "Limit",
  rename: "Rename fields",
};

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

  const [showRawJson, setShowRawJson] = React.useState(false);
  const [paramsText, setParamsText] = React.useState(() =>
    Object.keys(params).length > 0 ? JSON.stringify(params, null, 2) : "",
  );
  const [parseError, setParseError] = React.useState<string | null>(null);

  // Sync paramsText when params change from visual form
  const paramsRef = React.useRef(params);
  React.useEffect(() => {
    if (JSON.stringify(paramsRef.current) !== JSON.stringify(params)) {
      paramsRef.current = params;
      if (!showRawJson) {
        setParamsText(Object.keys(params).length > 0 ? JSON.stringify(params, null, 2) : "");
      }
    }
  }, [params, showRawJson]);

  const handleOperationChange = React.useCallback(
    (v: string) => {
      // Reset params when switching operations unless in raw JSON mode
      if (showRawJson) {
        try {
          const parsed = paramsText.trim() ? JSON.parse(paramsText) : {};
          onConfigChange("transform", { ...parsed, operation: v });
        } catch {
          onConfigChange("transform", { operation: v });
        }
      } else {
        onConfigChange("transform", { operation: v });
      }
    },
    [paramsText, showRawJson, onConfigChange],
  );

  function handleVisualParamChange(newParams: Record<string, unknown>) {
    onConfigChange("transform", { ...newParams, operation });
  }

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

  const hasVisualForm = VISUAL_OPERATIONS.has(operation);

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
            {Object.entries(OPERATION_LABELS).map(([op, lbl]) => (
              <SelectItem key={op} value={op}>{lbl}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>

      {/* Visual form for common operations */}
      {hasVisualForm && !showRawJson && (
        <div className="space-y-3">
          {(operation === "filter") && (
            <FilterForm params={params} onChange={handleVisualParamChange} />
          )}
          {(operation === "sort") && (
            <SortForm params={params} onChange={handleVisualParamChange} />
          )}
          {(operation === "aggregate") && (
            <AggregateForm params={params} onChange={handleVisualParamChange} />
          )}
          {(operation === "rename" || operation === "map") && (
            <RenameForm params={params} onChange={handleVisualParamChange} />
          )}
        </div>
      )}

      {/* Raw JSON fallback — always shown for non-visual operations, toggle for visual ones */}
      {(showRawJson || !hasVisualForm) && (
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
      )}

      {/* Advanced toggle — only for operations that have a visual form */}
      {hasVisualForm && (
        <button
          type="button"
          className="flex items-center gap-1 text-[11px] text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)] transition-colors"
          onClick={() => {
            if (!showRawJson) {
              // Sync current params to text when opening raw JSON
              setParamsText(Object.keys(params).length > 0 ? JSON.stringify(params, null, 2) : "");
            }
            setShowRawJson(!showRawJson);
          }}
        >
          <ChevronDown
            className={cn("h-3 w-3 transition-transform", showRawJson && "rotate-180")}
            aria-hidden
          />
          {showRawJson ? "Use visual editor" : "Advanced: Raw JSON"}
        </button>
      )}

      {!hasVisualForm && (
        <p className="text-[10px] text-[var(--color-muted-foreground)]">
          Enter operation-specific parameters as a JSON object. Changes apply on blur.
        </p>
      )}
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
