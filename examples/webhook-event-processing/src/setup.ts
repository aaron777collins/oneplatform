/**
 * Webhook Event Processing — Setup
 *
 * Creates the resources needed to receive and process webhook events through
 * OnePlatform: a webhook receiver (with HMAC-SHA256 signature verification),
 * an ontology entity type for stored events, an event-processing pipeline,
 * and a real-time event subscription for monitoring.
 *
 * Run with: npm run setup
 *
 * Required environment variables:
 *   OP_BASE_URL       — e.g. https://your-instance.example.com
 *   OP_API_KEY        — API key with connectors:write, ontologies:write, pipelines:write
 *   WEBHOOK_SECRET    — Shared secret for HMAC-SHA256 signature verification
 */

import { createClient } from "@oneplatform/sdk";
import type {
  ConnectorInstance,
  OntologySchema,
  Pipeline,
} from "@oneplatform/sdk";
import { createHmac } from "node:crypto";

// ---------------------------------------------------------------------------
// Config — read from environment so secrets never appear in source.
// ---------------------------------------------------------------------------

const BASE_URL = process.env["OP_BASE_URL"];
const API_KEY = process.env["OP_API_KEY"];
// WEBHOOK_SECRET must never fall back to a hardcoded default: it is the
// shared secret used to verify HMAC-SHA256 signatures on inbound webhooks.
// A known or weak default would allow anyone to forge verified requests.
const WEBHOOK_SECRET = process.env["WEBHOOK_SECRET"];

if (!BASE_URL || !API_KEY || !WEBHOOK_SECRET) {
  console.error(
    "Error: OP_BASE_URL, OP_API_KEY, and WEBHOOK_SECRET environment variables are required.\n" +
      "  export OP_BASE_URL=https://your-instance.example.com\n" +
      "  export OP_API_KEY=op_live_...\n" +
      "  export WEBHOOK_SECRET=whsec_your_shared_secret",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const client = createClient({
  baseUrl: BASE_URL,
  auth: { apiKey: API_KEY },
});

// ---------------------------------------------------------------------------
// Step 1: Create the webhook receiver connector
//
// A webhook receiver acts as an inbound endpoint that external systems POST
// events to. OnePlatform verifies each request's HMAC-SHA256 signature using
// the shared secret before accepting the payload. The receiver is configured
// with the path suffix that forms the final segment of the webhook URL:
//
//   https://your-instance.example.com/api/v1/webhooks/external-events
//
// The signature header name and HMAC algorithm are configurable per receiver
// so you can match whatever convention your event source uses.
// ---------------------------------------------------------------------------

async function createWebhookReceiver(): Promise<ConnectorInstance> {
  console.log("Step 1: Creating webhook receiver connector...");

  // Hash the webhook secret for storage. The platform stores the hash, not the
  // raw secret, and uses it to verify inbound HMAC signatures at receive time.
  const secretHash = createHmac("sha256", WEBHOOK_SECRET)
    .update("webhook_secret_verification")
    .digest("hex");

  const connector = await client.connectors.create({
    name: "External Events Receiver",
    // The webhook receiver plugin ships with every OnePlatform instance. It
    // provides inbound HTTP endpoint handling, signature verification, and
    // automatic event routing to pipelines.
    pluginId: "com.oneplatform.connectors.webhook-receiver",
    config: {
      // The path suffix becomes the final URL segment. Combined with the
      // platform base URL this produces the full webhook endpoint:
      //   POST {baseUrl}/api/v1/webhooks/external-events
      pathSuffix: "external-events",

      // HMAC configuration — must match what the sending system uses.
      hmacAlgorithm: "sha256",
      headerName: "X-Webhook-Signature",

      // The secret hash is stored encrypted at rest using AES-256-GCM.
      // The raw secret never leaves the sending system and this setup script.
      secretHash,

      // Event types this receiver accepts. Events with types not in this list
      // are accepted (returning 200) but silently dropped to prevent enumeration.
      acceptedEventTypes: [
        "order.created",
        "user.signup",
        "payment.completed",
        "inventory.update",
        "alert.triggered",
      ],

      // When a pipeline ID is set, every verified event is automatically
      // enqueued as a pipeline trigger with the event payload as input.
      targetPipeline: "webhook-event-pipeline",
    },
    // Webhook receivers don't use scheduled syncs — they are push-based.
    // Setting isEnabled to true activates the HTTP endpoint immediately.
    isEnabled: true,
  });

  console.log(`  Created webhook receiver: ${connector.id}`);
  console.log(`  Webhook URL: ${BASE_URL}/api/v1/webhooks/external-events`);
  console.log(`  Signature header: X-Webhook-Signature`);
  console.log(`  Algorithm: HMAC-SHA256`);
  return connector;
}

// ---------------------------------------------------------------------------
// Step 2: Define the WebhookEvent ontology entity type
//
// This entity type stores processed webhook events in the platform's data
// store. Each event is enriched with processing metadata before storage,
// making it queryable via the data API and visible in dashboard apps.
// ---------------------------------------------------------------------------

async function createEventOntology(): Promise<OntologySchema> {
  console.log("Step 2: Creating WebhookEvent ontology entity type...");

  const schema = await client.ontologies.create({
    name: "WebhookEvent",
    displayName: "Webhook Event",
    fields: [
      {
        name: "eventId",
        type: "string",
        required: true,
        indexed: true,
        description: "Unique event identifier from the sending system",
      },
      {
        name: "eventType",
        type: "string",
        required: true,
        indexed: true,
        description: "Dot-separated event type (e.g. order.created, payment.completed)",
      },
      {
        name: "source",
        type: "string",
        required: true,
        indexed: true,
        description: "Identifier of the system that sent the event",
      },
      {
        name: "timestamp",
        type: "datetime",
        required: true,
        indexed: true,
        description: "ISO 8601 timestamp when the event occurred at the source",
      },
      {
        name: "processedAt",
        type: "datetime",
        required: true,
        indexed: true,
        description: "ISO 8601 timestamp when OnePlatform finished processing the event",
      },
      {
        name: "entityType",
        type: "string",
        required: false,
        indexed: true,
        description: "The domain entity type this event relates to (Order, User, Payment, etc.)",
      },
      {
        name: "entityId",
        type: "string",
        required: false,
        indexed: true,
        description: "The domain entity ID this event relates to",
      },
      {
        name: "payload",
        type: "string",
        required: true,
        indexed: false,
        description: "JSON-serialized original event payload for audit and replay",
      },
      {
        name: "status",
        type: "string",
        required: true,
        indexed: true,
        description: "Processing status: received | validated | enriched | processed | failed",
      },
    ],
    relationships: [],
  });

  console.log(`  Created ontology entity: ${schema.id} (${schema.name})`);
  return schema;
}

// ---------------------------------------------------------------------------
// Step 3: Create the event-processing pipeline
//
// This pipeline implements the receive -> validate -> enrich -> branch ->
// store + notify flow defined in configs/event-pipeline.json. Each webhook
// event triggers a pipeline run that processes the event through these steps.
//
// The pipeline supports concurrent runs (up to 10) so high-throughput event
// streams are handled without queuing delays.
// ---------------------------------------------------------------------------

async function createEventPipeline(): Promise<Pipeline> {
  console.log("Step 3: Creating webhook event processing pipeline...");

  const pipeline = await client.pipelines.create({
    name: "Webhook Event Pipeline",
    slug: "webhook-event-pipeline",
    description:
      "Processes inbound webhook events through validation, enrichment, " +
      "type-based branching, storage, and notification. Triggered automatically " +
      "when the webhook receiver accepts a verified event.",
    definition: {
      version: 1,
      entryStepId: "receive-event",
      steps: [
        // Step 1: Receive — entry point that captures the raw webhook payload
        {
          id: "receive-event",
          name: "Receive Webhook Event",
          type: "webhook",
          inputs: {
            payload: { from: "pipeline.input", path: "body" },
            headers: { from: "pipeline.input", path: "headers" },
            eventType: { from: "pipeline.input", path: "eventType" },
          },
          onError: "fail",
        },

        // Step 2: Validate — check required fields are present
        {
          id: "validate-payload",
          name: "Validate Payload Schema",
          type: "code",
          inputs: {
            event: { from: "step", stepId: "receive-event", path: "output" },
          },
          expression: `
            (() => {
              const e = event;
              const required = ['event_id', 'event_type', 'timestamp', 'data'];
              const missing = required.filter(f => !e[f]);
              if (missing.length > 0) {
                throw new Error('Missing required fields: ' + missing.join(', '));
              }
              return { ...e, validated: true };
            })()
          `,
          onError: "fail",
        },

        // Step 3: Enrich — add platform processing metadata
        {
          id: "enrich-event",
          name: "Enrich Event Data",
          type: "code",
          inputs: {
            event: { from: "step", stepId: "validate-payload", path: "output" },
          },
          expression: `
            (() => {
              const e = event;
              return {
                ...e,
                enriched: {
                  processedAt: new Date().toISOString(),
                  source: 'webhook-receiver',
                  correlationId: e.event_id + '-' + Date.now(),
                  normalizedType: e.event_type.replace('.', '_').toUpperCase(),
                },
              };
            })()
          `,
          onError: "fail",
        },

        // Step 4: Branch — route by event type
        {
          id: "branch-by-type",
          name: "Branch by Event Type",
          type: "conditional",
          inputs: {
            event: { from: "step", stepId: "enrich-event", path: "output" },
          },
          condition: "event.event_type",
          onError: "fail",
        },

        // Step 5a: Store — write the processed event to the entity store
        {
          id: "store-event",
          name: "Store Processed Event",
          type: "connector",
          entityType: "WebhookEvent",
          writeMode: "upsert",
          inputs: {
            records: { from: "step", stepId: "branch-by-type", path: "output" },
          },
          onError: "fail",
        },

        // Step 5b: Notify — emit a platform event for downstream subscribers
        {
          id: "notify",
          name: "Send Notification",
          type: "code",
          inputs: {
            event: { from: "step", stepId: "store-event", path: "output" },
          },
          expression: `
            (() => {
              return {
                notified: true,
                eventType: event.event_type,
                entityType: event.processed?.entityType || 'Unknown',
                entityId: event.processed?.entityId || event.event_id,
                processedAt: event.enriched?.processedAt,
              };
            })()
          `,
          // Notification failures should not fail the pipeline — the event is
          // already stored. Use 'skip' so the run still completes successfully.
          onError: "skip",
        },
      ],
      options: {
        // Webhook events arrive independently — allow concurrent processing.
        allowConcurrentRuns: true,
        maxConcurrentRuns: 10,
        // Each step has 30 seconds before it times out.
        stepTimeout: 30_000,
        // Keep the last 500 runs for audit / debugging.
        retainRunsCount: 500,
      },
    },
    isActive: true,
  });

  console.log(`  Created pipeline: ${pipeline.id} (${pipeline.name})`);
  return pipeline;
}

// ---------------------------------------------------------------------------
// Step 4: Subscribe to processed events (optional monitoring)
//
// Sets up a real-time SSE subscription to watch for processed webhook events.
// This demonstrates how downstream systems can react to webhook events after
// they have been processed by the pipeline.
// ---------------------------------------------------------------------------

function subscribeToEvents(): void {
  console.log("Step 4: Subscribing to webhook event notifications...");

  const subscription = client.events.subscribe(
    {
      events: ["pipeline.run.completed", "pipeline.run.failed"],
      filter: {
        // Only listen for runs of our webhook pipeline.
        pipelineId: "webhook-event-pipeline",
      },
    },
    (event) => {
      const status = event.type === "pipeline.run.completed" ? "SUCCESS" : "FAILED";
      const payload = event.payload as Record<string, unknown>;
      console.log(
        `  [${event.occurredAt}] Pipeline run ${status}: ${payload["runId"] ?? "unknown"}`,
      );
    },
  );

  subscription.onStatus((status) => {
    console.log(`  Event subscription status: ${status}`);
  });

  subscription.onError((error) => {
    console.error(`  Event subscription error: ${error.message}`);
  });

  // Unsubscribe after 60 seconds of monitoring. In a real application you
  // would keep this running for the lifetime of your process.
  setTimeout(() => {
    console.log("  Closing event subscription after 60s monitoring window.");
    subscription.unsubscribe();
  }, 60_000);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Verify credentials before doing any write operations.
  console.log("Verifying connection...");
  const identity = await client.ping();
  console.log(
    `  Connected as ${identity.email} (tenant: ${identity.tenantId})\n`,
  );

  // Create resources in dependency order.
  const receiver = await createWebhookReceiver();
  console.log();

  const _schema = await createEventOntology();
  console.log();

  const pipeline = await createEventPipeline();
  console.log();

  // Start monitoring (non-blocking — runs in the background).
  subscribeToEvents();
  console.log();

  // Print summary.
  console.log("=".repeat(70));
  console.log("Setup complete. Your webhook receiver is ready to accept events.");
  console.log("=".repeat(70));
  console.log();
  console.log("Webhook endpoint:");
  console.log(`  POST ${BASE_URL}/api/v1/webhooks/external-events`);
  console.log();
  console.log("Required headers:");
  console.log("  Content-Type: application/json");
  console.log("  X-Webhook-Signature: sha256=<HMAC hex digest of request body>");
  console.log();
  console.log("Resources created:");
  console.log(`  Receiver connector: ${receiver.id}`);
  console.log(`  Ontology entity:    WebhookEvent`);
  console.log(`  Pipeline:           ${pipeline.id} (${pipeline.name})`);
  console.log();
  console.log("Next steps:");
  console.log("  1. Send a test event:  npm run test:events");
  console.log("  2. Run the handler:    npm run handler");
  console.log("  3. View pipeline runs: Settings -> Pipelines -> Webhook Event Pipeline -> Runs");
  console.log();
  console.log("Monitoring for events for 60 seconds... (press Ctrl+C to exit early)");
}

main().catch((err: unknown) => {
  console.error("Setup failed:", err instanceof Error ? err.message : err);
  client.destroy();
  process.exit(1);
});
