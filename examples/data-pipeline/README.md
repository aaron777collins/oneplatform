# Example: Data Pipeline

This example walks through creating a complete product catalog ingestion pipeline
from scratch using `@oneplatform/sdk`. It covers:

1. Registering a REST API connector instance (the data source)
2. Defining a `Product` ontology entity type (the schema)
3. Creating a pipeline that reads from the connector and writes to the platform
4. Triggering an immediate run and checking its status

## Prerequisites

- Node.js 18+
- A running OnePlatform instance (local or hosted)
- An API key with `connectors:write`, `ontologies:write`, and `pipelines:write` scopes

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Set your credentials
export OP_BASE_URL=https://your-instance.example.com
export OP_API_KEY=op_live_...

# 3. Run the setup script
npm run setup
```

The script is idempotent — if any step has already been completed (duplicate name
error) the script logs a warning and continues to the next step.

## What the script creates

| Resource | Name | Notes |
|---|---|---|
| Connector | `Products REST API` | Polls `https://api.example.com/products` |
| Ontology entity | `Product` | id, name, price, status, updatedAt fields |
| Pipeline | `Ingest Products` | connector → transform → write steps |

After setup, the pipeline runs immediately and its run ID is printed so you can
follow progress in the platform UI at `Settings → Pipelines`.

## Cleaning up

Delete the connector, ontology, and pipeline from the platform UI under
`Settings → Data Sources`, `Settings → Ontology`, and `Settings → Pipelines`
respectively, or call the corresponding `delete()` methods from the SDK.
