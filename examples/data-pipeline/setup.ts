/**
 * Data Pipeline Setup
 *
 * Demonstrates the full lifecycle for wiring a REST API data source into
 * OnePlatform: connector registration → ontology definition → pipeline creation
 * → immediate trigger. Each step is independent so you can skip the ones you
 * have already completed.
 *
 * Run with: npm run setup
 *
 * Required environment variables:
 *   OP_BASE_URL  — e.g. https://your-instance.example.com
 *   OP_API_KEY   — API key with connectors:write, ontologies:write, pipelines:write
 */

import { createClient } from "@oneplatform/sdk";
import type {
  ConnectorInstance,
  OntologySchema,
  Pipeline,
  PipelineRun,
} from "@oneplatform/sdk";

// ---------------------------------------------------------------------------
// Config — read from environment so secrets never appear in source.
// ---------------------------------------------------------------------------

const BASE_URL = process.env["OP_BASE_URL"];
const API_KEY = process.env["OP_API_KEY"];

if (!BASE_URL || !API_KEY) {
  console.error(
    "Error: OP_BASE_URL and OP_API_KEY environment variables are required.\n" +
      "  export OP_BASE_URL=https://your-instance.example.com\n" +
      "  export OP_API_KEY=op_live_...",
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
// Step 1: Create the connector instance
//
// A connector instance is a configured pointer to an external data source.
// We use the "rest-api" plugin (pre-installed on every OnePlatform instance)
// to poll the products endpoint every hour. The config keys match the plugin's
// configSchema — see the connector's marketplace listing for a full reference.
// ---------------------------------------------------------------------------

async function ensureConnector(): Promise<ConnectorInstance> {
  console.log("Step 1: Creating connector instance...");

  const connector = await client.connectors.create({
    name: "Products REST API",
    // The rest-api plugin ships with OnePlatform. Replace with a custom plugin
    // ID if you have built your own connector (see examples/custom-connector).
    pluginId: "com.oneplatform.connectors.rest-api",
    config: {
      baseUrl: "https://api.example.com",
      // Endpoint path relative to baseUrl. Supports {cursor} interpolation for
      // paginated APIs that accept a page token query parameter.
      path: "/products",
      method: "GET",
      // Map the API's pagination shape to the connector's cursor protocol.
      paginationStrategy: "cursor",
      cursorField: "nextPageToken",
      // Credential name — bind the actual API key via the platform UI under
      // Settings → Data Sources → <connector name> → Credentials.
      credentialName: "products_api_key",
      // How often the platform schedules automatic syncs (cron format, UTC).
      schedule: "0 * * * *",
    },
  });

  console.log(`  Created connector: ${connector.id} (${connector.name})`);
  return connector;
}

// ---------------------------------------------------------------------------
// Step 2: Define the Product ontology entity type
//
// The ontology is the schema layer. Defining an entity type here tells the
// platform how to validate, index, and store the data coming from the connector.
// Field types map directly to the PostgreSQL column types used in the data store.
// ---------------------------------------------------------------------------

async function ensureOntology(): Promise<OntologySchema> {
  console.log("Step 2: Creating Product ontology entity type...");

  const schema = await client.ontologies.create({
    // `name` is the internal identifier used in pipelines and API queries.
    // It must be PascalCase and unique within the tenant.
    name: "Product",
    displayName: "Product",
    fields: [
      {
        name: "id",
        // `string` maps to TEXT in the underlying store. Use this for opaque
        // external identifiers that you never aggregate numerically.
        type: "string",
        required: true,
        indexed: true,
        description: "Stable product identifier from the upstream system",
      },
      {
        name: "name",
        type: "string",
        required: true,
        indexed: false,
        description: "Human-readable product name",
      },
      {
        name: "price",
        // `number` maps to NUMERIC(18,4) — suitable for currency values.
        type: "number",
        required: true,
        indexed: true,
        description: "Unit price in USD",
      },
      {
        name: "status",
        type: "string",
        required: true,
        // Index status so the dashboard-app can filter efficiently.
        indexed: true,
        description: "Product lifecycle state: active | discontinued | draft",
      },
      {
        name: "updatedAt",
        // `datetime` stores an ISO 8601 timestamp with timezone. The ingestion
        // service uses this field to detect incremental changes automatically.
        type: "datetime",
        required: false,
        indexed: true,
        description: "Last modification timestamp from the upstream system",
      },
    ],
    relationships: [],
  });

  console.log(`  Created ontology entity: ${schema.id} (${schema.name})`);
  return schema;
}

// ---------------------------------------------------------------------------
// Step 3: Create the pipeline
//
// A pipeline wires steps together into a directed graph. The entryStepId marks
// where execution begins. Each step declares its input sources so the platform
// knows which prior step's output to pass in.
//
// This pipeline has three steps:
//   ingest-products   — connector step: pulls raw records from the data source
//   normalize-product — code step:     maps raw fields to the Product entity shape
//   write-products    — connector step: writes normalized records to the entity store
// ---------------------------------------------------------------------------

async function ensurePipeline(connectorId: string): Promise<Pipeline> {
  console.log("Step 3: Creating Ingest Products pipeline...");

  const pipeline = await client.pipelines.create({
    name: "Ingest Products",
    description:
      "Pulls product records from the REST API, normalizes them to the Product entity shape, " +
      "and writes them to the platform data store. Triggered hourly by the connector schedule.",
    definition: {
      version: 1,
      entryStepId: "ingest-products",
      steps: [
        {
          id: "ingest-products",
          name: "Fetch from Products REST API",
          // The `connector` step type drives the fetchBatch loop for the given
          // connector instance until hasMore is false.
          type: "connector",
          connectorId,
          onError: "fail",
        },
        {
          id: "normalize-product",
          name: "Normalize to Product entity",
          // The `code` step type runs an inline transformation expression.
          // The expression receives `input.records` (the raw DataRecord array from
          // the previous step) and must return a new array of shaped objects.
          type: "code",
          inputs: {
            records: { from: "step", stepId: "ingest-products", path: "records" },
          },
          // Map raw API fields to the Product ontology shape. The `data` property
          // of each DataRecord holds the raw API response object.
          expression: `
            records.map(r => ({
              sourceId: r.sourceId,
              data: {
                id:        r.data.product_id ?? r.sourceId,
                name:      r.data.title ?? r.data.name ?? "",
                price:     Number(r.data.price_usd ?? 0),
                status:    r.data.lifecycle_status ?? "active",
                updatedAt: r.data.updated_at ?? r.metadata?.updatedAt ?? null,
              },
            }))
          `,
          onError: "fail",
        },
        {
          id: "write-products",
          name: "Write to Product entity store",
          // The `connector` type with an `entityType` key writes records to the
          // platform's internal entity store rather than an external system.
          type: "connector",
          entityType: "Product",
          // Upsert semantics: existing records are updated if sourceId matches.
          writeMode: "upsert",
          inputs: {
            records: { from: "step", stepId: "normalize-product", path: "output" },
          },
          onError: "fail",
        },
      ],
      options: {
        // Prevent overlapping runs if the previous sync is still in flight.
        allowConcurrentRuns: false,
        // Keep the last 30 run records for audit / debugging.
        retainRunsCount: 30,
      },
    },
    isActive: true,
  });

  console.log(`  Created pipeline: ${pipeline.id} (${pipeline.name})`);
  return pipeline;
}

// ---------------------------------------------------------------------------
// Step 4: Trigger an immediate run
//
// Even though the connector schedules automatic syncs, calling trigger() here
// kicks off a first run immediately so you can verify the setup without waiting
// for the next scheduled window.
// ---------------------------------------------------------------------------

async function triggerPipeline(pipelineId: string): Promise<PipelineRun> {
  console.log("Step 4: Triggering immediate pipeline run...");

  const run = await client.pipelines.trigger(pipelineId);

  console.log(`  Run enqueued: ${run.id} (status: ${run.status})`);
  console.log(
    `  Track progress in the platform UI: Settings → Pipelines → Ingest Products → Runs`,
  );
  return run;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Verify credentials before doing any write operations — fail fast with a
  // clear error rather than an opaque 401 midway through the setup flow.
  console.log("Verifying connection...");
  const identity = await client.ping();
  console.log(
    `  Connected as ${identity.email} (tenant: ${identity.tenantId})\n`,
  );

  const connector = await ensureConnector();
  console.log();

  const _schema = await ensureOntology();
  console.log();

  const pipeline = await ensurePipeline(connector.id);
  console.log();

  await triggerPipeline(pipeline.id);
  console.log();

  console.log("Setup complete.");
  console.log(
    "Next step: open the platform UI and watch the run complete under " +
      "Settings → Pipelines → Ingest Products → Runs.",
  );

  // Release SSE connections and abort in-flight requests before the process exits.
  client.destroy();
}

main().catch((err: unknown) => {
  console.error("Setup failed:", err instanceof Error ? err.message : err);
  client.destroy();
  process.exit(1);
});
