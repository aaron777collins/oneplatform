# Example: Multi-Source ETL Pipeline

A CLI-driven ETL pipeline that extracts data from a **PostgreSQL** database (ecommerce orders) and a **MySQL** database (retail product catalog), maps fields to unified ontology schemas, deduplicates records, validates data quality, and loads everything into the OnePlatform entity store.

This example is designed for **data engineers** who want to understand how to build production-grade ETL pipelines on OnePlatform using either the `op` CLI or the TypeScript SDK.

## What you will learn

- How to configure PostgreSQL and MySQL database connectors
- How to define ontology entity types (schemas) for merged data
- How to build a multi-step pipeline with parallel extraction, field mapping, deduplication, and quality checks
- How to set up an hourly cron schedule for automated syncs
- How to monitor pipeline health and data quality from the command line

## Architecture

```
PostgreSQL (ecommerce)          MySQL (retail_ops)
       |                               |
       v                               v
  [Extract PG]                    [Extract MySQL]
       |          (parallel)           |
       v                               v
  [Map PG fields                 [Map MySQL fields
   to Order schema]               to Product schema]
       |                               |
       v                               v
  [Deduplicate                   [Deduplicate
   by orderId]                    by SKU]
       |                               |
       v                               v
  [Quality check:                [Quality check:
   required fields,               required fields,
   valid amounts]                 valid prices]
       |                               |
       v                               v
  [Load Orders]                  [Load Products]
       |                               |
       v                               v
   Order entity                  Product entity
   (unified store)               (unified store)
```

## Prerequisites

- **Node.js 18+** (only if using the TypeScript setup)
- **OnePlatform instance** (local or hosted) with the following plugins installed:
  - `com.oneplatform.connector-postgres` (PostgreSQL connector)
  - `com.oneplatform.connector-mysql` (MySQL connector)
- **API key** with these scopes: `connectors:write`, `ontology:write`, `pipelines:manage`
- **`op` CLI** installed and authenticated (for the CLI-based setup)
- **`jq`** (for the CLI scripts to parse JSON)
- **Database proxy** configured for both PostgreSQL and MySQL (connectors use the platform's REST proxy, not direct TCP connections)

## Quick start

You can set up the pipeline in two ways: via the TypeScript SDK or via the `op` CLI.

### Option A: TypeScript SDK

```bash
# 1. Install dependencies
cd examples/multi-source-etl
npm install

# 2. Set your credentials
export OP_BASE_URL=https://your-instance.example.com
export OP_API_KEY=op_live_...

# 3. Run the setup script
npm run setup
```

### Option B: CLI script

```bash
# 1. Make sure the op CLI is installed and authenticated
op auth login

# 2. Set your credentials (if not already configured via op auth)
export OP_BASE_URL=https://your-instance.example.com
export OP_API_KEY=op_live_...

# 3. Run the CLI setup script
npm run setup:cli
# or directly:
bash scripts/setup.sh
```

Both options create identical resources. The CLI script is useful for CI/CD pipelines and infrastructure-as-code workflows where you want to version-control the setup process in shell scripts.

## Project structure

```
multi-source-etl/
  configs/
    postgres-connector.json   PostgreSQL connector configuration
    mysql-connector.json      MySQL connector configuration
    entity-order.json         Unified Order ontology entity schema
    entity-product.json       Unified Product ontology entity schema
    etl-pipeline.json         Full pipeline definition (all steps)
    schedule.json             Hourly cron schedule configuration
  scripts/
    setup.sh                  CLI-based setup (creates all resources)
    monitor.sh                CLI-based monitoring dashboard
  src/
    setup.ts                  TypeScript SDK setup (creates all resources)
  package.json
  README.md
```

## Connector setup

### PostgreSQL connector

The PostgreSQL connector uses the platform's database REST proxy to read from your database. The connector plugin runs inside a sandboxed environment and cannot open direct TCP connections.

**Configuration** (`configs/postgres-connector.json`):

| Field | Value | Description |
|---|---|---|
| `proxyUrl` | `https://db-proxy.internal.example.com/postgres` | Platform DB proxy endpoint |
| `table` | `orders` | Table to sync from |
| `schema` | `ecommerce` | PostgreSQL schema name |
| `primaryKey` | `order_id` | Column used as the unique record identifier |
| `incrementalColumn` | `updated_at` | Column for cursor-based incremental sync |
| `batchSize` | `2000` | Rows fetched per batch (max: 10000) |

**Credentials**: The `connectionString` credential is stored in the platform's secret vault and bound to the proxy at runtime. It is never exposed to the plugin code.

To update the connector config after creation:

```bash
op connector update <connector-id> --config configs/postgres-connector.json
```

### MySQL connector

The MySQL connector works the same way, routing queries through the platform's MySQL REST proxy.

**Configuration** (`configs/mysql-connector.json`):

| Field | Value | Description |
|---|---|---|
| `proxyUrl` | `https://db-proxy.internal.example.com/mysql` | Platform DB proxy endpoint |
| `database` | `retail_ops` | MySQL database name |
| `table` | `product_catalog` | Table to sync from |
| `incrementalColumn` | `last_modified` | Column for cursor-based incremental sync |
| `batchSize` | `1000` | Rows fetched per batch (max: 10000) |

## Schema mapping

### Source fields to ontology fields

Each source database has its own column naming conventions. The pipeline's code steps map these to the unified ontology schema.

**PostgreSQL orders -> Order entity:**

| Source column | Ontology field | Transform |
|---|---|---|
| `order_id` | `orderId` | Prefixed with `pg-` for deduplication |
| `customer_id` | `customerId` | Cast to string |
| `email` | `customerEmail` | Direct |
| `order_date` / `created_at` | `orderDate` | Fallback chain |
| `total_amount` | `totalAmount` | Cast to number |
| `currency` | `currency` | Default: `USD` |
| `status` | `status` | Lowercased |
| `ship_street`, `ship_city`, `ship_state`, `ship_zip` | `shippingAddress` | Joined with commas |
| `line_item_count` | `lineItemCount` | Cast to number |
| (constant) | `source` | `postgres-ecommerce` |
| `updated_at` | `updatedAt` | Direct |

**MySQL products -> Product entity:**

| Source column | Ontology field | Transform |
|---|---|---|
| `sku` | `sku` | Direct |
| `product_name` / `name` | `name` | Fallback chain |
| `long_description` / `description` | `description` | Fallback chain |
| `category_name` / `category` | `category` | Fallback chain |
| `retail_price` / `price` | `unitPrice` | Cast to number |
| `cost_price` | `costPrice` | Cast to number |
| `qty_on_hand` / `stock` | `stockQuantity` | Cast to number |
| `weight_kg` | `weight` | Cast to number |
| `is_active` | `status` | Boolean to enum mapping |
| (constant) | `source` | `mysql-retail` |
| `last_modified` | `updatedAt` | Direct |

You can also define these mappings declaratively using the `op mapping` command:

```bash
# Map a single field
op mapping create Order \
  --connector <pg-connector-id> \
  --source-field "order_id" \
  --target-field "orderId" \
  --transform-type expression \
  --transform "'pg-' + value"

# Preview how mappings would transform sample data
op mapping preview Order \
  --connector <pg-connector-id> \
  --sample sample-records.json
```

## Pipeline orchestration

The pipeline definition (`configs/etl-pipeline.json`) contains 11 steps organized into 5 phases:

### Phase 1: Parallel extraction

Both source connectors run simultaneously inside a `parallel` step. This cuts wall-clock time roughly in half compared to sequential extraction.

```
extract-parallel (parallel)
  |-- extract-postgres   (connector step)
  |-- extract-mysql      (connector step)
```

### Phase 2: Field mapping

Code steps transform source-specific field names into the unified ontology schema. Each record gets a `source` field and a prefixed `sourceId` to prevent key collisions.

### Phase 3: Deduplication

A merge step deduplicates records by primary key (orderId for orders, SKU for products). When duplicates exist, the record with the most recent `updatedAt` wins.

### Phase 4: Quality checks

Validation code steps check that required fields are present and values are sensible (e.g., `totalAmount >= 0`). Records that fail validation are placed in a `rejected` array and excluded from the load step, but they do not cause the pipeline to fail.

### Phase 5: Load

Validated records are written to the entity store using upsert semantics. Existing records with the same `sourceId` are updated rather than duplicated, making the pipeline safe to run repeatedly (idempotent).

### Pipeline configuration options

| Option | Value | Purpose |
|---|---|---|
| `allowConcurrentRuns` | `false` | Prevents overlapping runs |
| `retainRunsCount` | `50` | Keep last 50 runs for audit trail |
| `stepTimeout` | `300` | 5-minute timeout per step |

## Monitoring

### One-shot health check

```bash
npm run monitor
# or:
bash scripts/monitor.sh
```

This prints a health report covering:

1. Platform connectivity
2. Connector status and connection tests
3. Pipeline run history (last 5 runs)
4. Entity record counts by source
5. Schedule status and next run time
6. Recent error logs

### Watch mode

```bash
bash scripts/monitor.sh --watch
bash scripts/monitor.sh --watch --interval=60   # check every 60s
```

### Individual monitoring commands

```bash
# Check platform health
op status

# List all connectors and their status
op connector list

# Test a specific connector's connection
op connector test <connector-id>

# View pipeline run history
op pipeline runs <pipeline-id> --limit 10

# Stream live logs for a running pipeline
op pipeline run-logs <run-id> --follow

# Get the status of a specific run
op pipeline run-status <run-id>

# Query merged order data
op data query Order --limit 20 --sort orderDate --sort-dir desc

# Query merged product data
op data query Product --filter 'status eq "active"' --limit 20

# View recent pipeline errors
op logs query --service pipeline --level error --limit 10

# Stream all pipeline logs in real time
op logs tail --service pipeline --level info
```

## Troubleshooting

### Connector connection failures

**Symptom**: `op connector test <id>` returns "Connection failed"

**Common causes**:

1. **Proxy URL unreachable**: Verify the database proxy is running and the URL in the connector config is correct. The proxy must be accessible from the OnePlatform service network.

2. **Invalid credentials**: Check that the `connectionString` credential stored in the platform vault is correct. Update it via:
   ```bash
   op connector update <id> --credentials updated-credentials.json
   ```

3. **Database permissions**: The database user must have `SELECT` permission on the target table and schema. For PostgreSQL, also verify schema access:
   ```sql
   GRANT USAGE ON SCHEMA ecommerce TO readonly;
   GRANT SELECT ON ecommerce.orders TO readonly;
   ```

4. **Network/firewall**: The platform's database proxy must be able to reach the database server. Check security groups, VPC peering, or firewall rules.

### Pipeline failures

**Symptom**: `op pipeline run-status <run-id>` shows `failed`

**Debugging steps**:

1. Check the run logs for the specific error:
   ```bash
   op pipeline run-logs <run-id> --level error
   ```

2. Check which step failed:
   ```bash
   op pipeline run-logs <run-id> --step <step-id>
   ```

3. Common step-level failures:
   - **extract-postgres / extract-mysql**: Connector or proxy issue. Test the connector separately with `op connector test`.
   - **map-postgres-orders / map-mysql-products**: Field mapping error. The source data may have unexpected field names. Check a sample with `op data query`.
   - **quality-check-***: Data quality issues are logged but do not fail the pipeline. Check the step output for the `rejected` array and `stats` summary.
   - **load-***: Entity store write failure. Verify the ontology schema matches the mapped data shape with `op ontology get Order`.

### Incremental sync not picking up changes

**Symptom**: New or updated records in the source database are not appearing in the entity store.

1. **Check the cursor**: The connector saves a cursor after each successful sync. If the `incrementalColumn` (e.g., `updated_at`) is not being updated in the source database, the connector will not see the change.

2. **Force a full sync**: Reset the cursor by triggering a full sync:
   ```bash
   op connector trigger <id> --mode full --force
   ```

3. **Check the incrementalColumn**: Verify the column exists and is being populated. For PostgreSQL:
   ```sql
   SELECT updated_at FROM ecommerce.orders ORDER BY updated_at DESC LIMIT 5;
   ```

### Schema mismatch after source changes

**Symptom**: New columns appear in the source database but are not mapped.

1. Preview the diff between the proposed and current ontology schema:
   ```bash
   op ontology diff Order --file configs/entity-order.json
   ```

2. Update the ontology schema:
   ```bash
   op ontology update Order --file configs/entity-order.json
   ```

3. If the change is breaking (e.g., removing a required field), run a migration:
   ```bash
   op ontology migrate Order --wait
   ```

## Cleaning up

Delete all resources created by this example:

```bash
# Delete the schedule first (it references the pipeline)
op schedule list --pipeline <pipeline-id>
op schedule delete <schedule-id> --yes

# Delete the pipeline
op pipeline delete <pipeline-id> --yes

# Delete the connectors
op connector delete <pg-connector-id> --yes
op connector delete <mysql-connector-id> --yes

# Delete the ontology entities (deletes all stored data)
op ontology delete Order --confirm
op ontology delete Product --confirm
```

## Further reading

- [Connector Plugin Reference](../../plugins/connector-postgres/README.md) — PostgreSQL connector configuration details
- [Connector Plugin Reference](../../plugins/connector-mysql/README.md) — MySQL connector configuration details
- [CLI Command Reference](../../packages/cli/README.md) — Full `op` CLI documentation
- [SDK API Reference](../../packages/sdk/README.md) — TypeScript SDK usage and types
- [Pipeline Design Guide](../../docs/designs/) — Architecture and design documents
- [Data Pipeline Example](../data-pipeline/) — Simpler single-source pipeline example
