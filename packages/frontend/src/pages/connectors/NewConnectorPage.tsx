/**
 * NewConnectorPage — multi-step connector creation wizard.
 * Steps: 1) Choose type → 2) Configure → 3) Test connection → 4) Save
 * Route: /connectors/new
 */
import React, { useState, useEffect } from "react";
import { useNavigate, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, XCircle, Loader2, Puzzle, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card.js";
import { PageHeader } from "@/components/layout/PageHeader.js";
import { ConnectorForm, type ConnectorFormValues } from "@/components/connectors/ConnectorForm.js";
import { useApiClient, type ApiResponse, ApiError } from "@/lib/api-client.js";
import { toast } from "@/hooks/use-toast.js";
import type { ConnectorConfigSchema } from "@/components/connectors/ConnectorForm.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Step = "choose-type" | "configure" | "test" | "done";

interface RegistryEntry {
  type: string;
  displayName: string;
  description: string;
  version: string;
  category: string;
  author: string;
  icon?: string;
  configSchema?: ConnectorConfigSchema | null;
  installCount: number;
  builtIn: boolean;
}

interface RegistryListResult {
  items: RegistryEntry[];
  nextCursor: string | null;
  total: number;
}

interface ConnectorTypeOption {
  id: string;
  name: string;
  description: string;
  configSchema: ConnectorConfigSchema;
}

interface CreatedConnector {
  id: string;
  name: string;
}

type TestStatus = "idle" | "testing" | "success" | "failed";

// ---------------------------------------------------------------------------
// Step indicator
// ---------------------------------------------------------------------------

const STEPS: { key: Step; label: string }[] = [
  { key: "choose-type", label: "Choose type" },
  { key: "configure", label: "Configure" },
  { key: "test", label: "Test connection" },
  { key: "done", label: "Done" },
];

function StepIndicator({ current }: { current: Step }) {
  const currentIdx = STEPS.findIndex((s) => s.key === current);
  return (
    <ol role="list" className="flex items-center gap-0">
      {STEPS.map((step, idx) => {
        const done = idx < currentIdx;
        const active = idx === currentIdx;
        return (
          <li key={step.key} className="flex items-center">
            <div
              className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${
                done
                  ? "bg-[var(--color-primary)] text-[var(--color-primary-foreground)]"
                  : active
                  ? "border-2 border-[var(--color-primary)] text-[var(--color-primary)]"
                  : "border-2 border-[var(--color-border)] text-[var(--color-muted-foreground)]"
              }`}
              aria-current={active ? "step" : undefined}
            >
              {done ? "✓" : idx + 1}
            </div>
            <span
              className={`ml-2 text-sm ${
                active ? "font-semibold" : "text-[var(--color-muted-foreground)]"
              }`}
            >
              {step.label}
            </span>
            {idx < STEPS.length - 1 && (
              <div className="mx-3 h-px w-8 bg-[var(--color-border)]" aria-hidden />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// NewConnectorPage component
// ---------------------------------------------------------------------------

export function NewConnectorPage() {
  const client = useApiClient();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState<Step>("choose-type");
  const [selectedType, setSelectedType] = useState<ConnectorTypeOption | null>(null);
  const [connectorName, setConnectorName] = useState("");
  const [formValues, setFormValues] = useState<ConnectorFormValues | null>(null);
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  // Fetch available connector types from the built-in connector registry
  const { data: typesData, isLoading: typesLoading } = useQuery({
    queryKey: ["connector-types"],
    queryFn: async () => {
      const result = await client.get<RegistryListResult>("/v1/connector-registry", { limit: "100" });
      // Unwrap response envelope if present
      const inner = (result as unknown as { data?: RegistryListResult })?.data ?? result;
      const entries = inner?.items ?? [];
      const options: ConnectorTypeOption[] = entries.map((entry: RegistryEntry) => ({
        id: entry.type,
        name: entry.displayName,
        description: entry.description,
        configSchema: entry.configSchema ?? { type: "object" as const, properties: {} },
      }));
      return { data: options };
    },
  });

  // Auto-select connector type when pluginId (registry type string) is passed from marketplace
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const pluginId = params.get("pluginId");
    if (pluginId !== null && typesData?.data !== undefined && currentStep === "choose-type") {
      const match = typesData.data.find((t) => t.id === pluginId);
      if (match !== undefined) {
        setConnectorName(`My ${match.name}`);
        handleTypeSelect(match);
      }
    }
  }, [typesData]); // eslint-disable-line react-hooks/exhaustive-deps

  const createConnector = useMutation({
    mutationFn: (body: { pluginId: string; name: string; config: ConnectorFormValues; credentials?: Record<string, unknown> }) =>
      client.post<ApiResponse<CreatedConnector>>("/v1/connectors", body),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["connectors"] });
      setCreatedId(result.data.id);
      // After creation, test the connection
      void testAfterCreate(result.data.id);
    },
    onError: (err) => {
      const message = err instanceof ApiError ? err.message : "Failed to create connector";
      toast({ title: message, variant: "destructive" });
    },
  });

  // --- Step handlers ---

  function handleTypeSelect(type: ConnectorTypeOption) {
    setSelectedType(type);
    setCurrentStep("configure");
  }

  async function handleConfigureSubmit(values: ConnectorFormValues) {
    if (selectedType === null) return;
    setFormValues(values);
    setCurrentStep("test");
    setTestStatus("testing");
    setTestError(null);
    const finalName = connectorName.trim() || selectedType.name;
    createConnector.mutate({
      pluginId: selectedType.id,
      name: finalName,
      config: values,
    });
  }

  async function testAfterCreate(connectorId: string) {
    setTestStatus("testing");
    setTestError(null);
    try {
      await client.post(`/v1/connectors/${connectorId}/test`);
      setTestStatus("success");
      setCurrentStep("done");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Connection test failed";
      setTestStatus("failed");
      setTestError(message);
      // Still go to done since the connector was created
      setCurrentStep("done");
    }
  }

  async function retryTest() {
    if (createdId === null) return;
    setTestStatus("testing");
    setTestError(null);
    try {
      await client.post(`/v1/connectors/${createdId}/test`);
      setTestStatus("success");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Connection test failed";
      setTestStatus("failed");
      setTestError(message);
    }
  }

  const connectorTypes = typesData?.data ?? [];

  return (
    <div className="flex-1 overflow-y-auto">
      <PageHeader
        title="New connector"
        breadcrumbs={[
          { label: "Platform" },
          { label: "Connectors", href: "/connectors" },
          { label: "New" },
        ]}
      />

      <div className="p-6 space-y-6">
        <StepIndicator current={currentStep} />

        {/* Step 1: Choose type */}
        {currentStep === "choose-type" && (
          <div className="space-y-3">
            <h2 className="text-base font-semibold">Select connector type</h2>
            {typesLoading ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-24 animate-pulse rounded-lg border border-[var(--color-border)] bg-[var(--color-muted)]"
                  />
                ))}
              </div>
            ) : connectorTypes.length === 0 ? (
              <div className="flex flex-col items-start gap-4 rounded-lg border border-[var(--color-border)] bg-[var(--color-muted)]/40 p-6 max-w-lg">
                <div className="flex items-center gap-3">
                  <Puzzle className="h-8 w-8 text-[var(--color-muted-foreground)]" aria-hidden />
                  <div>
                    <p className="text-sm font-medium">No connectors set up yet</p>
                    <p className="text-sm text-[var(--color-muted-foreground)] mt-0.5">
                      Browse the marketplace to find and install a connector.
                      Connectors let you bring in data from databases, SaaS apps,
                      file systems, and more.
                    </p>
                  </div>
                </div>
                <Link
                  to="/connectors/marketplace"
                  className="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-primary)] px-3 py-2 text-sm font-medium text-[var(--color-primary-foreground)] hover:opacity-90 transition-opacity"
                >
                  <Puzzle className="h-4 w-4" aria-hidden />
                  Browse Connector Marketplace
                </Link>
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  After installing a connector from the marketplace, return here to
                  create your first connection.
                </p>
              </div>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {connectorTypes.map((type) => (
                  <Card
                    key={type.id}
                    className="cursor-pointer transition-shadow hover:shadow-md hover:border-[var(--color-primary)]"
                    onClick={() => handleTypeSelect(type)}
                  >
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">{type.name}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <CardDescription>{type.description}</CardDescription>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Step 2: Configure */}
        {currentStep === "configure" && selectedType !== null && (
          <div className="max-w-lg space-y-3">
            <h2 className="text-base font-semibold">Configure {selectedType.name}</h2>
            <div className="space-y-2">
              <label htmlFor="connector-name" className="text-sm font-medium">
                Connector name
                <span className="ml-1 text-[var(--color-destructive)]" aria-hidden>*</span>
              </label>
              <Input
                id="connector-name"
                placeholder={`My ${selectedType.name} connector`}
                value={connectorName}
                onChange={(e) => setConnectorName(e.target.value)}
              />
            </div>
            <ConnectorForm
              schema={selectedType.configSchema}
              onSubmit={(values) => void handleConfigureSubmit(values)}
              submitLabel="Test connection"
            />
            <Button
              variant="ghost"
              onClick={() => setCurrentStep("choose-type")}
            >
              Back
            </Button>
          </div>
        )}

        {/* Step 3: Creating & testing connection */}
        {currentStep === "test" && (
          <div className="max-w-md space-y-4">
            <h2 className="text-base font-semibold">Creating and testing connection</h2>

            <div className="flex items-center gap-3 rounded-md border border-[var(--color-border)] p-4">
              {(testStatus === "testing" || createConnector.isPending) && !createConnector.isError && (
                <>
                  <Loader2 className="h-5 w-5 animate-spin text-[var(--color-primary)]" aria-hidden />
                  <p className="text-sm">
                    {createConnector.isPending ? "Creating connector…" : "Testing connection…"}
                  </p>
                </>
              )}
              {createConnector.isError && (
                <>
                  <AlertCircle className="h-5 w-5 text-[var(--color-destructive)]" aria-hidden />
                  <div>
                    <p className="text-sm font-medium text-[var(--color-destructive)]">
                      Failed to create connector
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                      {createConnector.error instanceof ApiError
                        ? createConnector.error.message
                        : "An unexpected error occurred. Please try again."}
                    </p>
                  </div>
                </>
              )}
              {testStatus === "success" && !createConnector.isPending && !createConnector.isError && (
                <>
                  <CheckCircle2 className="h-5 w-5 text-[var(--color-status-success)]" aria-hidden />
                  <p className="text-sm font-medium text-[var(--color-status-success)]">
                    Connection successful
                  </p>
                </>
              )}
              {testStatus === "failed" && !createConnector.isPending && !createConnector.isError && (
                <>
                  <XCircle className="h-5 w-5 text-[var(--color-destructive)]" aria-hidden />
                  <div>
                    <p className="text-sm font-medium text-[var(--color-destructive)]">
                      Connection test failed
                    </p>
                    {testError !== null && (
                      <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                        {testError}
                      </p>
                    )}
                    <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                      The connector was created but the connection test did not pass. You can retry the test or check the connector settings.
                    </p>
                  </div>
                </>
              )}
            </div>

            {/* Back button — shown when create mutation fails so user can go back and fix config */}
            {createConnector.isError && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    createConnector.reset();
                    setTestStatus("idle");
                    setCurrentStep("configure");
                  }}
                >
                  Back to configuration
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Step 4: Done */}
        {currentStep === "done" && (
          <div className="max-w-md space-y-4">
            <div className={`flex items-center gap-3 rounded-md border p-4 ${
              testStatus === "success"
                ? "border-[var(--color-status-success)]/30 bg-[var(--color-status-success)]/10"
                : "border-[var(--color-border)]"
            }`}>
              {testStatus === "success" ? (
                <CheckCircle2 className="h-5 w-5 text-[var(--color-status-success)]" aria-hidden />
              ) : testStatus === "testing" ? (
                <Loader2 className="h-5 w-5 animate-spin text-[var(--color-primary)]" aria-hidden />
              ) : (
                <XCircle className="h-5 w-5 text-[var(--color-destructive)]" aria-hidden />
              )}
              <div>
                <p className="text-sm font-medium">Connector created</p>
                {testStatus === "success" && (
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    Your connector is ready to use. Connection test passed.
                  </p>
                )}
                {testStatus === "testing" && (
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    Testing connection…
                  </p>
                )}
                {testStatus === "failed" && (
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    Connector was created but the connection test failed.
                    {testError !== null && ` ${testError}`}
                  </p>
                )}
              </div>
            </div>
            <div className="flex gap-2">
              {createdId !== null && (
                <Button
                  onClick={() => void navigate({ to: "/connectors/$id", params: { id: createdId } })}
                >
                  View connector
                </Button>
              )}
              {testStatus === "failed" && createdId !== null && (
                <>
                  <Button
                    variant="outline"
                    onClick={() => void retryTest()}
                  >
                    Retry test
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void navigate({ to: "/connectors/$id", params: { id: createdId } })}
                  >
                    Edit settings
                  </Button>
                </>
              )}
              <Button
                variant="outline"
                onClick={() => void navigate({ to: "/connectors" })}
              >
                All connectors
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
