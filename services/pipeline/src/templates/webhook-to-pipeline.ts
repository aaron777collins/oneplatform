// Template: Webhook-Triggered Processing
//
// A pipeline that accepts an inbound webhook payload, validates its shape via
// a field-existence condition, fans out processing across two parallel
// branches (transform + notify), then confirms completion via an outbound callback.
//
// This template demonstrates the parallel step type — callers must provide
// at least two meaningful branch IDs.  The notify branch destination must
// be an HTTPS URL (SSRF policy).

import type { PipelineDefinition } from "../schemas/index.js";

export interface WebhookToPipelineParams {
  /** Ontology entity type the payload belongs to */
  entityType: string;
  /** Transformer plugin ID for the transform branch */
  transformerId: string;
  /** HTTPS URL to notify when processing completes */
  notificationWebhookUrl: string;
  /**
   * The top-level field name in the pipeline input that must exist for the payload
   * to be considered valid and processed.  Defaults to "payload".
   */
  requiredPayloadField?: string;
}

export function webhookToPipelineTemplate(
  params: WebhookToPipelineParams,
): PipelineDefinition {
  const {
    entityType,
    transformerId,
    notificationWebhookUrl,
    requiredPayloadField = "payload",
  } = params;
  // The condition evaluator accesses this field by name from the pipeline input
  const payloadField = requiredPayloadField;

  return {
    version: 1,
    entryStepId: "validate-payload",
    steps: [
      // Guard: reject payloads that do not contain the required field so
      // downstream steps never receive invalid data.  The condition checks
      // that the configured payloadField exists in the pipeline input.
      {
        id: "validate-payload",
        name: "Validate Inbound Payload",
        type: "conditional",
        condition: {
          field: payloadField,
          operator: "exists",
        },
        thenStepId: "fan-out",
        elseStepId: "reject-payload",
      },
      {
        id: "reject-payload",
        name: "Reject Invalid Payload",
        type: "code",
        language: "typescript",
        code: `
export function handler(): never {
  throw new Error("Webhook payload failed validation — processing rejected.");
}
`.trim(),
        entrypoint: "handler",
        onError: "fail",
      },

      // Parallel: transform the data AND send the notification concurrently.
      // Both branches must complete before the confirmation step runs.
      {
        id: "fan-out",
        name: "Fan-Out: Transform + Notify",
        type: "parallel",
        waitMode: "all",
        inputs: {
          payload: { from: "pipeline.input", path: "$.payload" },
        },
        branches: [
          {
            id: "branch-transform",
            entryStepId: "transform-entity",
            steps: [
              {
                id: "transform-entity",
                name: `Transform ${entityType} Payload`,
                type: "transformer",
                transformerId,
                entityType,
                inputs: {
                  data: { from: "pipeline.input", path: "$.payload" },
                },
                onError: "fail",
              },
              {
                id: "upsert-entity",
                name: `Upsert ${entityType} to Ontology`,
                type: "code",
                language: "typescript",
                code: `
export async function handler(record: unknown): Promise<{ upserted: number }> {
  const response = await fetch(
    process.env["ONTOLOGY_SERVICE_URL"] + "/internal/entities/bulk-upsert",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entityType: "${entityType}", records: [record] }),
    },
  );
  if (!response.ok) throw new Error(\`Upsert failed: \${response.status}\`);
  return (await response.json()) as { upserted: number };
}
`.trim(),
                entrypoint: "handler",
                inputs: {
                  record: { from: "step", stepId: "transform-entity" },
                },
                onError: "fail",
                retryConfig: {
                  maxRetries: 2,
                  backoffMs: 1000,
                  backoffMultiplier: 2,
                },
              },
            ],
          },
          {
            id: "branch-notify",
            entryStepId: "send-notification",
            steps: [
              {
                id: "send-notification",
                name: "Send Processing Notification",
                type: "webhook",
                url: notificationWebhookUrl,
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Pipeline-Event": "webhook.received",
                },
                body: {
                  event: "webhook.received",
                  entityType,
                },
                timeout: 10_000,
              },
            ],
          },
        ],
      },

      // Confirmation: runs after both branches succeed.
      {
        id: "confirm-complete",
        name: "Confirm Processing Complete",
        type: "code",
        language: "typescript",
        code: `
export function handler(): { status: string; entityType: string } {
  return { status: "completed", entityType: "${entityType}" };
}
`.trim(),
        entrypoint: "handler",
        inputs: {
          result: { from: "step", stepId: "fan-out" },
        },
        onError: "fail",
      },
    ],
    options: {
      // Webhook-triggered pipelines can run concurrently — each inbound event
      // is independent.  Cap at 10 to avoid overwhelming downstream services.
      maxConcurrentRuns: 10,
      allowConcurrentRuns: true,
      retainRunsCount: 500,
    },
  };
}
