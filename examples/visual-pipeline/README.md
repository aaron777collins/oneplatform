# Visual Pipeline Builder

## What is the Visual Pipeline Builder?

The Visual Pipeline Builder is OnePlatform's drag-and-drop interface for creating data
integration pipelines without writing code. You compose pipelines by placing **nodes**
(sources, transforms, destinations) on a canvas and drawing **connections** between them.
Under the hood every pipeline is stored as a JSON definition that the OnePlatform
Pipeline Service executes.

This directory contains five ready-made pipeline definitions that cover the most common
integration patterns. You can import any of them into the UI, inspect their
configuration, modify them, and run them against your own data sources.

### Key concepts

| Concept | Description |
|---------|-------------|
| **Node** | A single processing step (source, transform, filter, destination). |
| **Connection** | A directed edge that routes data from one node's output to another node's input. |
| **Step config** | Each node carries a `config` object whose shape depends on its `type`. |
| **Layout metadata** | Every node stores `position: { x, y }` so the canvas can render it. |

### Directory structure

```
visual-pipeline/
  README.md                          # This file
  pipelines/
    csv-to-postgres.json             # Pipeline 1 — CSV import
    api-sync.json                    # Pipeline 2 — REST API sync
    webhook-processor.json           # Pipeline 3 — Webhook events
    scheduled-export.json            # Pipeline 4 — Scheduled export
    multi-source-merge.json          # Pipeline 5 — Multi-source merge
```

---

## Pipeline 1: CSV to PostgreSQL

Import rows from a CSV file, validate and transform them, then upsert into a
PostgreSQL table.

```
 ┌────────────┐     ┌──────────────┐     ┌───────────────┐     ┌────────────────┐
 │  CSV File  │────▶│ Parse & Map  │────▶│  Validate     │────▶│  PostgreSQL    │
 │  Source    │     │  Columns     │     │  Schema       │     │  Upsert        │
 └────────────┘     └──────────────┘     └───────────────┘     └────────────────┘
```

**Use case:** Periodic bulk-import of customer or product data exported from a
legacy system.

**File:** `pipelines/csv-to-postgres.json`

### How it works

1. **CSV Source** — reads the file from a configured path or an uploaded blob.
2. **Column Mapper** — renames and casts columns (e.g. `full_name` to `name`,
   string dates to ISO-8601).
3. **Schema Validator** — rejects rows that do not match the target table schema
   and routes them to an error log.
4. **PostgreSQL Destination** — performs an `INSERT ... ON CONFLICT UPDATE`
   (upsert) keyed on `email`.

---

## Pipeline 2: REST API Sync

Pull records from an external REST API on a schedule and merge them into the
local datastore.

```
 ┌────────────────┐     ┌───────────────┐     ┌──────────────┐     ┌────────────────┐
 │  REST API      │────▶│  Paginate &   │────▶│  Deduplicate │────▶│  PostgreSQL    │
 │  Source        │     │  Flatten      │     │  by ID       │     │  Upsert        │
 └────────────────┘     └───────────────┘     └──────────────┘     └────────────────┘
```

**Use case:** Keeping a local copy of contacts from a CRM (e.g. HubSpot,
Salesforce) synchronized every 15 minutes.

**File:** `pipelines/api-sync.json`

### How it works

1. **REST Source** — calls `GET /api/v2/contacts` with Bearer token auth.
   Automatically follows `next` pagination links.
2. **Flatten Transform** — extracts nested `properties.*` fields into
   top-level columns.
3. **Deduplication** — groups by `external_id` and keeps only the most
   recently modified record.
4. **PostgreSQL Destination** — upserts on `external_id`.

---

## Pipeline 3: Webhook Event Processing

Listen for incoming webhook payloads, filter and enrich them, then fan out to
multiple destinations.

```
 ┌────────────────┐     ┌───────────────┐     ┌──────────────┐     ┌────────────────┐
 │  Webhook       │────▶│  Filter by    │────▶│  Enrich      │──┬─▶│  PostgreSQL    │
 │  Listener      │     │  Event Type   │     │  (Lookup)    │  │  │  Insert        │
 └────────────────┘     └───────────────┘     └──────────────┘  │  └────────────────┘
                                                                │  ┌────────────────┐
                                                                └─▶│  Slack         │
                                                                   │  Notification  │
                                                                   └────────────────┘
```

**Use case:** Processing Stripe payment webhooks — store the event and send a
Slack alert for high-value transactions.

**File:** `pipelines/webhook-processor.json`

### How it works

1. **Webhook Source** — exposes `POST /hooks/stripe-events`.
2. **Event Filter** — passes only `invoice.paid` and `charge.succeeded`
   events; discards the rest.
3. **Enrichment Lookup** — joins the Stripe `customer` ID against the local
   `customers` table to attach the customer name and plan.
4. **Fan-out** — the enriched payload is sent to both:
   - **PostgreSQL** — inserted into `payment_events`.
   - **Slack** — a formatted message is posted to `#billing-alerts` when
     `amount >= 50000` (cents).

---

## Pipeline 4: Scheduled Data Export

Run a SQL query every day at 02:00 UTC and export the results as a CSV to an
S3 bucket.

```
 ┌────────────────┐     ┌───────────────┐     ┌──────────────┐     ┌────────────────┐
 │  PostgreSQL    │────▶│  Format as    │────▶│  Compress    │────▶│  S3 Bucket     │
 │  Query         │     │  CSV          │     │  (gzip)      │     │  Upload        │
 └────────────────┘     └───────────────┘     └──────────────┘     └────────────────┘
```

**Use case:** Nightly export of the previous day's order data for a downstream
analytics warehouse.

**File:** `pipelines/scheduled-export.json`

### How it works

1. **PostgreSQL Source** — executes a parameterized query with
   `{{ yesterday }}` date token.
2. **CSV Formatter** — converts the result set into RFC 4180 CSV with a
   header row.
3. **Gzip Compress** — compresses the payload to reduce transfer size.
4. **S3 Destination** — uploads to
   `s3://acme-exports/orders/{{ date }}.csv.gz` using IAM role credentials.

---

## Pipeline 5: Multi-Source Merge

Pull data from three independent sources, normalize the schemas, merge on a
shared key, and load into a unified table.

```
 ┌────────────────┐
 │  PostgreSQL    │──┐
 │  (Customers)   │  │
 └────────────────┘  │  ┌───────────────┐     ┌──────────────┐     ┌────────────────┐
                     ├─▶│  Normalize &  │────▶│  Merge on    │────▶│  PostgreSQL    │
 ┌────────────────┐  │  │  Cast Types   │     │  customer_id │     │  (Unified)     │
 │  REST API      │──┤  └───────────────┘     └──────────────┘     └────────────────┘
 │  (Orders)      │  │
 └────────────────┘  │
                     │
 ┌────────────────┐  │
 │  CSV File      │──┘
 │  (Support)     │
 └────────────────┘
```

**Use case:** Building a 360-degree customer view by joining CRM contacts,
order history from an API, and support tickets from a CSV export.

**File:** `pipelines/multi-source-merge.json`

### How it works

1. **Three sources** run in parallel:
   - **PostgreSQL** — `SELECT * FROM customers`
   - **REST API** — `GET /api/orders?status=completed`
   - **CSV File** — `support_tickets_2024.csv`
2. **Normalize** — all three streams are cast to a common schema (lowercase
   column names, ISO dates, nullable fields).
3. **Merge** — a full outer join on `customer_id` produces a single wide
   record per customer.
4. **PostgreSQL Destination** — the merged dataset is written to
   `customer_360`.

---

## How to Test and Run

### Importing a pipeline

1. Open the OnePlatform UI and navigate to **Pipelines > Builder**.
2. Click **Import** in the toolbar.
3. Select one of the `.json` files from this directory.
4. The canvas will render all nodes and connections automatically.

### Running a pipeline

1. After importing, click **Validate** to check that all connections and
   configs are complete.
2. Fix any warnings (missing credentials, unreachable hosts).
3. Click **Run** to execute the pipeline immediately, or **Schedule** to
   attach a cron expression.
4. Monitor progress in the **Runs** tab. Each node shows its status
   (pending, running, succeeded, failed) in real time.

### Running from the CLI

```bash
# Create a pipeline from a JSON definition file
op pipeline create --file pipelines/csv-to-postgres.json

# List pipelines to find the ID assigned by the platform
op pipeline list

# Trigger a pipeline run (replace <pipeline-id> with the ID from the list above)
op pipeline trigger <pipeline-id>

# Wait for the run to complete and stream status to stderr
op pipeline trigger <pipeline-id> --wait

# Check the run history for a pipeline
op pipeline runs <pipeline-id> --limit 5

# Get the status of a specific run (replace <run-id> with the ID printed by trigger)
op pipeline run-status <run-id>

# Stream live logs for a run
op pipeline run-logs <run-id> --follow
```

### Running from the SDK

```typescript
import { OnePlatform } from '@oneplatform/sdk';

const client = new OnePlatform({ apiKey: process.env.OP_API_KEY });

// Import a pipeline from a JSON definition
const pipeline = await client.pipelines.import('./pipelines/csv-to-postgres.json');

// Execute and wait for completion
const run = await client.pipelines.run(pipeline.id, { wait: true });
console.log(`Run ${run.id} finished with status: ${run.status}`);
```

### Tips

- **Dry-run mode** — pass `{ dryRun: true }` in the pipeline definition's trigger input or set the `dryRun` flag via the SDK (`{ dryRun: true }`) to validate the pipeline without writing to any destination. From the CLI: `op pipeline trigger <id> --input '{"dryRun":true}'`.
- **Environment variables** — credentials should never be hard-coded. Use
  `{{ env.DB_PASSWORD }}` tokens in the JSON configs and set the values in
  your `.env` file or the UI's **Secrets** panel.
- **Error handling** — every pipeline supports a global `onError` handler.
  Set it to `"pause"` during development so you can inspect failures, or
  `"skip"` in production to continue processing remaining rows.
