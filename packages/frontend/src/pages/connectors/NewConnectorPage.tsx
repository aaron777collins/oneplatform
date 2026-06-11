/**
 * NewConnectorPage — multi-step connector creation wizard.
 * Steps: 1) Choose type → 2) Configure → 3) Test connection → 4) Save
 * Route: /connectors/new
 */
import React, { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
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
  const [formValues, setFormValues] = useState<ConnectorFormValues | null>(null);
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");
  const [testError, setTestError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  // Fetch available connector types from the plugin registry
  const { data: typesData, isLoading: typesLoading } = useQuery({
    queryKey: ["connector-types"],
    queryFn: () => client.get<{ data: ConnectorTypeOption[] }>("/v1/connectors/types"),
  });

  const createConnector = useMutation({
    mutationFn: (body: { typeId: string; config: ConnectorFormValues }) =>
      client.post<ApiResponse<CreatedConnector>>("/v1/connectors", body),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["connectors"] });
      setCreatedId(result.data.id);
      setCurrentStep("done");
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
    setFormValues(values);
    setCurrentStep("test");
    await runTest(values);
  }

  async function runTest(values: ConnectorFormValues) {
    if (selectedType === null) return;
    setTestStatus("testing");
    setTestError(null);
    try {
      await client.post(`/v1/connectors/test`, {
        typeId: selectedType.id,
        config: values,
      });
      setTestStatus("success");
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Connection test failed";
      setTestStatus("failed");
      setTestError(message);
    }
  }

  function handleSave() {
    if (selectedType === null || formValues === null) return;
    createConnector.mutate({ typeId: selectedType.id, config: formValues });
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
              <p className="text-sm text-[var(--color-muted-foreground)]">
                No connector types available. Install a connector plugin to get started.
              </p>
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

        {/* Step 3: Test connection */}
        {currentStep === "test" && (
          <div className="max-w-md space-y-4">
            <h2 className="text-base font-semibold">Test connection</h2>

            <div className="flex items-center gap-3 rounded-md border border-[var(--color-border)] p-4">
              {testStatus === "testing" && (
                <>
                  <Loader2 className="h-5 w-5 animate-spin text-[var(--color-primary)]" aria-hidden />
                  <p className="text-sm">Testing connection…</p>
                </>
              )}
              {testStatus === "success" && (
                <>
                  <CheckCircle2 className="h-5 w-5 text-[var(--color-status-success)]" aria-hidden />
                  <p className="text-sm font-medium text-[var(--color-status-success)]">
                    Connection successful
                  </p>
                </>
              )}
              {testStatus === "failed" && (
                <>
                  <XCircle className="h-5 w-5 text-[var(--color-destructive)]" aria-hidden />
                  <div>
                    <p className="text-sm font-medium text-[var(--color-destructive)]">
                      Connection failed
                    </p>
                    {testError !== null && (
                      <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
                        {testError}
                      </p>
                    )}
                  </div>
                </>
              )}
            </div>

            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setCurrentStep("configure")}
              >
                Back
              </Button>
              {testStatus === "failed" && formValues !== null && (
                <Button
                  variant="outline"
                  onClick={() => void runTest(formValues)}
                >
                  Retry test
                </Button>
              )}
              <Button
                onClick={handleSave}
                disabled={testStatus === "testing" || createConnector.isPending}
                aria-busy={createConnector.isPending}
              >
                {createConnector.isPending ? "Saving…" : "Save connector"}
              </Button>
            </div>
          </div>
        )}

        {/* Step 4: Done */}
        {currentStep === "done" && (
          <div className="max-w-md space-y-4">
            <div className="flex items-center gap-3 rounded-md border border-[var(--color-status-success)]/30 bg-[var(--color-status-success)]/10 p-4">
              <CheckCircle2 className="h-5 w-5 text-[var(--color-status-success)]" aria-hidden />
              <div>
                <p className="text-sm font-medium">Connector created</p>
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  Your connector is ready to use.
                </p>
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
