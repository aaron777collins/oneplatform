// Template: Sync REST API to PostgreSQL
//
// Pulls data from a REST API connector instance, normalises the records through
// an optional transformer, then upserts them into an ontology entity type via
// a code step.  The connector and transformer IDs are caller-supplied so the
// same template can be instantiated for any source/target combination.

import type { PipelineDefinition } from "../schemas/index.js";

export interface SyncToPostgresParams {
  /** UUID of an existing Ingestion Service connector instance */
  connectorInstanceId: string;
  /** Target ontology entity type (e.g. "product", "order") */
  entityType: string;
  /** ID of a transformer plugin to apply after the connector sync (optional) */
  transformerId?: string;
  /** Full sync reloads all records; incremental only processes new/changed ones */
  syncMode?: "full" | "incremental";
}

export function syncToPostgresTemplate(
  params: SyncToPostgresParams,
): PipelineDefinition {
  const { connectorInstanceId, entityType, transformerId, syncMode = "incremental" } = params;

  const steps: PipelineDefinition["steps"] = [
    {
      id: "sync-connector",
      name: "Sync REST API Connector",
      type: "connector",
      connectorInstanceId,
      syncMode,
      waitForCompletion: true,
      onError: "fail",
    },
  ];

  // Transformer is optional — skip the step when not requested so the
  // definition stays minimal and the execution engine has fewer steps to plan.
  if (transformerId !== undefined) {
    steps.push({
      id: "transform-records",
      name: "Transform Records",
      type: "transformer",
      transformerId,
      entityType,
      inputs: {
        data: { from: "step", stepId: "sync-connector" },
      },
      onError: "fail",
    });
  }

  const lastStepId = transformerId !== undefined ? "transform-records" : "sync-connector";

  // Upsert step runs inline TypeScript inside the Execution Service sandbox.
  // It receives the output of whichever step ran last and writes to the ontology.
  steps.push({
    id: "upsert-to-ontology",
    name: `Upsert to ${entityType} Ontology`,
    type: "code",
    language: "typescript",
    code: `
// Receives the normalised records from the prior step and upserts them
// into the ontology.  The ontology service URL is injected via the execution
// environment; do not hard-code it here.
export async function handler(input: unknown): Promise<{ upserted: number }> {
  const records: unknown[] = Array.isArray(input) ? input : [input];
  // The execution sandbox exposes fetch(); no import needed.
  const response = await fetch(
    process.env["ONTOLOGY_SERVICE_URL"] + "/internal/entities/bulk-upsert",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityType: "${entityType}", records }),
    },
  );
  if (!response.ok) {
    throw new Error(\`Ontology upsert failed: \${response.status}\`);
  }
  const body = await response.json() as { upserted: number };
  return { upserted: body.upserted };
}
`.trim(),
    entrypoint: "handler",
    inputs: {
      data: { from: "step", stepId: lastStepId },
    },
    onError: "fail",
    retryConfig: {
      maxRetries: 3,
      backoffMs: 2000,
      backoffMultiplier: 2,
    },
  });

  return {
    version: 1,
    entryStepId: "sync-connector",
    steps,
    options: {
      maxConcurrentRuns: 1,
      allowConcurrentRuns: false,
      retainRunsCount: 100,
    },
  };
}
