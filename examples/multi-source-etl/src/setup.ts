/**
 * Multi-Source ETL Pipeline Setup
 *
 * Creates a complete ETL pipeline that merges data from a PostgreSQL database
 * (ecommerce orders) and a MySQL database (retail product catalog) into
 * unified Order and Product ontology entities.
 *
 * The pipeline flow:
 *   1. Extract from PostgreSQL and MySQL connectors in parallel
 *   2. Map source-specific fields to the unified ontology schema
 *   3. Deduplicate records by primary key (orderId / SKU)
 *   4. Run data quality validation on each record
 *   5. Load validated records into the platform entity store
 *
 * Run with: npm run setup
 *
 * Required environment variables:
 *   OP_BASE_URL  — e.g. https://your-instance.example.com
 *   OP_API_KEY   — API key with connectors:write, ontology:write, pipelines:manage
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
// Step 1: Create the PostgreSQL connector
//
// This connector instance points to the ecommerce database's orders table.
// The proxyUrl is the platform-managed database proxy endpoint — the plugin
// never receives the actual connection string directly. Credentials are
// stored in the platform's secret vault and bound at runtime.
//
// We use incremental sync mode with `updated_at` as the cursor column so
// that subsequent runs only fetch rows that changed since the last sync.
// ---------------------------------------------------------------------------

async function createPostgresConnector(): Promise<ConnectorInstance> {
  console.log("Step 1: Creating PostgreSQL connector (ecommerce.orders)...");

  const connector = await client.connectors.create({
    name: "Ecommerce PostgreSQL - Orders",
    pluginId: "com.oneplatform.connector-postgres",
    config: {
      proxyUrl: "https://db-proxy.internal.example.com/postgres",
      table: "orders",
      schema: "ecommerce",
      primaryKey: "order_id",
      incrementalColumn: "updated_at",
      batchSize: 2000,
    },
    credentials: {
      connectionString: "postgresql://readonly:****@pg-primary.internal:5432/ecommerce",
    },
    syncMode: "incremental",
    isEnabled: true,
    scheduleCron: "0 * * * *",
  });

  console.log(`  Created connector: ${connector.id} (${connector.name})`);
  return connector;
}

// ---------------------------------------------------------------------------
// Step 2: Create the MySQL connector
//
// This connector instance points to the retail operations database's product
// catalog table. The MySQL connector also communicates through the platform
// proxy — raw TCP connections are not available from the sandbox environment.
//
// The `last_modified` column drives incremental sync so that only recently
// updated products are re-ingested on each run.
// ---------------------------------------------------------------------------

async function createMysqlConnector(): Promise<ConnectorInstance> {
  console.log("Step 2: Creating MySQL connector (retail_ops.product_catalog)...");

  const connector = await client.connectors.create({
    name: "Retail Ops MySQL - Products",
    pluginId: "com.oneplatform.connector-mysql",
    config: {
      proxyUrl: "https://db-proxy.internal.example.com/mysql",
      database: "retail_ops",
      table: "product_catalog",
      incrementalColumn: "last_modified",
      batchSize: 1000,
    },
    credentials: {
      connectionString: "mysql://readonly:****@mysql-primary.internal:3306/retail_ops",
    },
    syncMode: "incremental",
    isEnabled: true,
    scheduleCron: "0 * * * *",
  });

  console.log(`  Created connector: ${connector.id} (${connector.name})`);
  return connector;
}

// ---------------------------------------------------------------------------
// Step 3: Define the Order ontology entity type
//
// The Order entity unifies order records from both databases into a single
// schema. Fields are designed to accommodate the superset of columns from
// both sources — fields only present in one source are marked as optional.
//
// The `source` field tracks which system each record originated from,
// enabling downstream queries to filter or aggregate by source.
// ---------------------------------------------------------------------------

async function createOrderEntity(): Promise<OntologySchema> {
  console.log("Step 3: Creating Order ontology entity type...");

  const schema = await client.ontologies.create({
    name: "Order",
    displayName: "Unified Order",
    fields: [
      {
        name: "orderId",
        type: "string",
        required: true,
        indexed: true,
        description: "Unique order identifier from the source system (prefixed with source name for deduplication)",
      },
      {
        name: "customerId",
        type: "string",
        required: true,
        indexed: true,
        description: "Customer identifier from the originating system",
      },
      {
        name: "customerEmail",
        type: "string",
        required: false,
        indexed: true,
        description: "Customer email address for cross-system matching",
      },
      {
        name: "orderDate",
        type: "datetime",
        required: true,
        indexed: true,
        description: "Timestamp when the order was placed (ISO 8601)",
      },
      {
        name: "totalAmount",
        type: "number",
        required: true,
        indexed: true,
        description: "Total order value in USD",
      },
      {
        name: "currency",
        type: "string",
        required: true,
        indexed: false,
        description: "ISO 4217 currency code (e.g. USD, EUR, GBP)",
      },
      {
        name: "status",
        type: "string",
        required: true,
        indexed: true,
        description: "Normalized order status: pending | confirmed | shipped | delivered | cancelled | refunded",
      },
      {
        name: "shippingAddress",
        type: "string",
        required: false,
        indexed: false,
        description: "Full shipping address as a single line",
      },
      {
        name: "lineItemCount",
        type: "number",
        required: false,
        indexed: false,
        description: "Number of distinct line items in the order",
      },
      {
        name: "source",
        type: "string",
        required: true,
        indexed: true,
        description: "Originating data source: postgres-ecommerce | mysql-retail",
      },
      {
        name: "updatedAt",
        type: "datetime",
        required: false,
        indexed: true,
        description: "Last modification timestamp from the source system",
      },
    ],
    relationships: [
      {
        name: "products",
        targetEntity: "Product",
        cardinality: "many",
      },
    ],
  });

  console.log(`  Created ontology entity: ${schema.id} (${schema.name})`);
  return schema;
}

// ---------------------------------------------------------------------------
// Step 4: Define the Product ontology entity type
//
// The Product entity captures the unified product catalog from the MySQL
// retail operations system. Like Order, it includes a `source` field and
// normalizes status values across systems.
// ---------------------------------------------------------------------------

async function createProductEntity(): Promise<OntologySchema> {
  console.log("Step 4: Creating Product ontology entity type...");

  const schema = await client.ontologies.create({
    name: "Product",
    displayName: "Unified Product",
    fields: [
      {
        name: "sku",
        type: "string",
        required: true,
        indexed: true,
        description: "Stock keeping unit — the canonical product identifier across all systems",
      },
      {
        name: "name",
        type: "string",
        required: true,
        indexed: false,
        description: "Product display name",
      },
      {
        name: "description",
        type: "string",
        required: false,
        indexed: false,
        description: "Long-form product description",
      },
      {
        name: "category",
        type: "string",
        required: false,
        indexed: true,
        description: "Product category (e.g. Electronics, Apparel, Home & Kitchen)",
      },
      {
        name: "unitPrice",
        type: "number",
        required: true,
        indexed: true,
        description: "Current retail unit price in USD",
      },
      {
        name: "costPrice",
        type: "number",
        required: false,
        indexed: false,
        description: "Wholesale or cost price in USD (from operations system)",
      },
      {
        name: "stockQuantity",
        type: "number",
        required: false,
        indexed: true,
        description: "Current available inventory count",
      },
      {
        name: "weight",
        type: "number",
        required: false,
        indexed: false,
        description: "Product weight in kilograms for shipping calculations",
      },
      {
        name: "status",
        type: "string",
        required: true,
        indexed: true,
        description: "Lifecycle state: active | discontinued | out_of_stock | draft",
      },
      {
        name: "source",
        type: "string",
        required: true,
        indexed: true,
        description: "Originating data source: postgres-ecommerce | mysql-retail",
      },
      {
        name: "updatedAt",
        type: "datetime",
        required: false,
        indexed: true,
        description: "Last modification timestamp from the source system",
      },
    ],
    relationships: [
      {
        name: "orders",
        targetEntity: "Order",
        cardinality: "many",
      },
    ],
  });

  console.log(`  Created ontology entity: ${schema.id} (${schema.name})`);
  return schema;
}

// ---------------------------------------------------------------------------
// Step 5: Create the ETL pipeline
//
// The pipeline orchestrates the full ETL flow:
//
//   extract-parallel (parallel)
//     |-- extract-postgres  (connector step)
//     |-- extract-mysql     (connector step)
//   |
//   map-postgres-orders     (code step — field mapping)
//   map-mysql-products      (code step — field mapping)
//   |
//   merge-orders            (code step — deduplication)
//   merge-products          (code step — deduplication)
//   |
//   quality-check-orders    (code step — validation)
//   quality-check-products  (code step — validation)
//   |
//   load-orders             (connector step — upsert to entity store)
//   load-products           (connector step — upsert to entity store)
//
// The parallel step at the top ensures both source extractions happen
// concurrently, reducing wall-clock time. Subsequent steps run sequentially.
// ---------------------------------------------------------------------------

async function createPipeline(
  pgConnectorId: string,
  mysqlConnectorId: string,
): Promise<Pipeline> {
  console.log("Step 5: Creating Multi-Source ETL pipeline...");

  const pipeline = await client.pipelines.create({
    name: "Multi-Source ETL Pipeline",
    slug: "multi-source-etl",
    description:
      "Extracts order and product data from PostgreSQL (ecommerce) and MySQL (retail ops), " +
      "maps fields to unified ontology entities, merges overlapping records, " +
      "runs data quality checks, and loads into the platform data store.",
    definition: {
      version: 1,
      entryStepId: "extract-parallel",
      steps: [
        // --- Extraction (parallel) ---
        {
          id: "extract-parallel",
          name: "Extract from both sources in parallel",
          type: "parallel",
          branches: [
            { stepId: "extract-postgres" },
            { stepId: "extract-mysql" },
          ],
          onError: "fail",
        },
        {
          id: "extract-postgres",
          name: "Extract from PostgreSQL (ecommerce.orders)",
          type: "connector",
          connectorId: pgConnectorId,
          onError: "fail",
        },
        {
          id: "extract-mysql",
          name: "Extract from MySQL (retail_ops.product_catalog)",
          type: "connector",
          connectorId: mysqlConnectorId,
          onError: "fail",
        },

        // --- Field Mapping ---
        // Map source-specific column names to the unified ontology field names.
        // Each mapper also prefixes the sourceId to prevent key collisions
        // between systems that may use overlapping ID ranges.
        {
          id: "map-postgres-orders",
          name: "Map PostgreSQL fields to Order entity",
          type: "code",
          inputs: {
            records: { from: "step", stepId: "extract-postgres", path: "records" },
          },
          expression: `
            records.map(r => ({
              sourceId: 'pg-' + r.data.order_id,
              data: {
                orderId:         'pg-' + r.data.order_id,
                customerId:      String(r.data.customer_id),
                customerEmail:   r.data.email || null,
                orderDate:       r.data.order_date || r.data.created_at,
                totalAmount:     Number(r.data.total_amount || 0),
                currency:        r.data.currency || 'USD',
                status:          (r.data.status || 'pending').toLowerCase(),
                shippingAddress: [
                  r.data.ship_street,
                  r.data.ship_city,
                  r.data.ship_state,
                  r.data.ship_zip,
                ].filter(Boolean).join(', ') || null,
                lineItemCount:   Number(r.data.line_item_count || 0),
                source:          'postgres-ecommerce',
                updatedAt:       r.data.updated_at || null,
              },
            }))
          `,
          onError: "fail",
        },
        {
          id: "map-mysql-products",
          name: "Map MySQL fields to Product entity",
          type: "code",
          inputs: {
            records: { from: "step", stepId: "extract-mysql", path: "records" },
          },
          expression: `
            records.map(r => ({
              sourceId: 'my-' + r.data.sku,
              data: {
                sku:           r.data.sku,
                name:          r.data.product_name || r.data.name,
                description:   r.data.long_description || r.data.description || null,
                category:      r.data.category_name || r.data.category || null,
                unitPrice:     Number(r.data.retail_price || r.data.price || 0),
                costPrice:     Number(r.data.cost_price || 0) || null,
                stockQuantity: Number(r.data.qty_on_hand || r.data.stock || 0),
                weight:        r.data.weight_kg ? Number(r.data.weight_kg) : null,
                status:        (r.data.is_active === 1 || r.data.is_active === true)
                                 ? 'active'
                                 : (r.data.qty_on_hand === 0 ? 'out_of_stock' : 'discontinued'),
                source:        'mysql-retail',
                updatedAt:     r.data.last_modified || null,
              },
            }))
          `,
          onError: "fail",
        },

        // --- Merge / Deduplication ---
        // When the same logical record appears more than once (e.g. due to
        // overlapping extraction windows), keep the version with the most
        // recent updatedAt timestamp.
        {
          id: "merge-orders",
          name: "Deduplicate orders by orderId",
          type: "code",
          inputs: {
            mapped: { from: "step", stepId: "map-postgres-orders", path: "output" },
          },
          expression: `
            const seen = new Map();
            for (const r of mapped) {
              const key = r.data.orderId;
              const existing = seen.get(key);
              if (!existing || (r.data.updatedAt &&
                  (!existing.data.updatedAt || r.data.updatedAt > existing.data.updatedAt))) {
                seen.set(key, r);
              }
            }
            Array.from(seen.values())
          `,
          onError: "fail",
        },
        {
          id: "merge-products",
          name: "Deduplicate products by SKU",
          type: "code",
          inputs: {
            mapped: { from: "step", stepId: "map-mysql-products", path: "output" },
          },
          expression: `
            const seen = new Map();
            for (const r of mapped) {
              const key = r.data.sku;
              const existing = seen.get(key);
              if (!existing || (r.data.updatedAt &&
                  (!existing.data.updatedAt || r.data.updatedAt > existing.data.updatedAt))) {
                seen.set(key, r);
              }
            }
            Array.from(seen.values())
          `,
          onError: "fail",
        },

        // --- Data Quality Checks ---
        // Validate that required fields are present and have sensible values.
        // Records that fail validation are separated into a `rejected` array
        // so they can be reviewed without blocking the rest of the pipeline.
        {
          id: "quality-check-orders",
          name: "Validate order data quality",
          type: "code",
          inputs: {
            records: { from: "step", stepId: "merge-orders", path: "output" },
          },
          expression: `
            const valid = [];
            const rejected = [];
            for (const r of records) {
              const errors = [];
              if (!r.data.orderId) errors.push('missing orderId');
              if (!r.data.customerId) errors.push('missing customerId');
              if (typeof r.data.totalAmount !== 'number' || r.data.totalAmount < 0)
                errors.push('invalid totalAmount');
              if (!r.data.orderDate) errors.push('missing orderDate');
              if (errors.length > 0) {
                rejected.push({ ...r, qualityErrors: errors });
              } else {
                valid.push(r);
              }
            }
            ({
              valid,
              rejected,
              stats: {
                total: records.length,
                passed: valid.length,
                failed: rejected.length,
              },
            })
          `,
          onError: "fail",
        },
        {
          id: "quality-check-products",
          name: "Validate product data quality",
          type: "code",
          inputs: {
            records: { from: "step", stepId: "merge-products", path: "output" },
          },
          expression: `
            const valid = [];
            const rejected = [];
            for (const r of records) {
              const errors = [];
              if (!r.data.sku) errors.push('missing sku');
              if (!r.data.name) errors.push('missing name');
              if (typeof r.data.unitPrice !== 'number' || r.data.unitPrice < 0)
                errors.push('invalid unitPrice');
              if (errors.length > 0) {
                rejected.push({ ...r, qualityErrors: errors });
              } else {
                valid.push(r);
              }
            }
            ({
              valid,
              rejected,
              stats: {
                total: records.length,
                passed: valid.length,
                failed: rejected.length,
              },
            })
          `,
          onError: "fail",
        },

        // --- Load ---
        // Write validated records into the platform entity store using upsert
        // semantics. Records with the same sourceId are updated rather than
        // duplicated, making the pipeline safe to run repeatedly.
        {
          id: "load-orders",
          name: "Load validated orders into entity store",
          type: "connector",
          entityType: "Order",
          writeMode: "upsert",
          inputs: {
            records: { from: "step", stepId: "quality-check-orders", path: "valid" },
          },
          onError: "fail",
        },
        {
          id: "load-products",
          name: "Load validated products into entity store",
          type: "connector",
          entityType: "Product",
          writeMode: "upsert",
          inputs: {
            records: { from: "step", stepId: "quality-check-products", path: "valid" },
          },
          onError: "fail",
        },
      ],
      options: {
        // Prevent overlapping runs when the previous sync is still in flight.
        allowConcurrentRuns: false,
        // Keep the last 50 run records for audit and debugging.
        retainRunsCount: 50,
        // Each step gets at most 5 minutes before the platform marks it failed.
        stepTimeout: 300,
      },
    },
    isActive: true,
  });

  console.log(`  Created pipeline: ${pipeline.id} (${pipeline.name})`);
  return pipeline;
}

// ---------------------------------------------------------------------------
// Step 6: Trigger an immediate run
//
// Kick off the pipeline immediately so you can verify the setup without
// waiting for the hourly cron schedule. The run ID is printed so you can
// track progress via the CLI or the platform UI.
// ---------------------------------------------------------------------------

async function triggerPipeline(pipelineId: string): Promise<PipelineRun> {
  console.log("Step 6: Triggering immediate pipeline run...");

  const run = await client.pipelines.trigger(pipelineId);

  console.log(`  Run enqueued: ${run.id} (status: ${run.status})`);
  console.log(
    "  Track progress:\n" +
      "    CLI:  op pipeline run-logs " + run.id + " --follow\n" +
      "    UI:   Settings > Pipelines > Multi-Source ETL Pipeline > Runs",
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

  // Step 1-2: Create connectors for both data sources
  const pgConnector = await createPostgresConnector();
  console.log();

  const mysqlConnector = await createMysqlConnector();
  console.log();

  // Step 3-4: Define unified ontology entity types
  const _orderSchema = await createOrderEntity();
  console.log();

  const _productSchema = await createProductEntity();
  console.log();

  // Step 5: Wire everything together in a pipeline
  const pipeline = await createPipeline(pgConnector.id, mysqlConnector.id);
  console.log();

  // Step 6: Run it now
  await triggerPipeline(pipeline.id);
  console.log();

  console.log("Setup complete.");
  console.log(
    "The pipeline will also run automatically every hour.\n" +
      "To monitor: npm run monitor\n" +
      "To check status: op pipeline runs " + pipeline.id,
  );

  // Release SSE connections and abort in-flight requests before the process exits.
  client.destroy();
}

main().catch((err: unknown) => {
  console.error("Setup failed:", err instanceof Error ? err.message : err);
  client.destroy();
  process.exit(1);
});
