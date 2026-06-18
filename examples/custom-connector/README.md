# Example: Custom Connector Plugin

This example shows how to build a connector plugin that ingests product data from
a REST API into OnePlatform. The connector implements the `Connector` interface
from `@oneplatform/plugin-sdk` and is packaged with a `manifest.json` that the
platform uses for installation and the marketplace listing.

## What a connector does

The Ingestion Service drives the connector lifecycle:

1. Calls `connect()` once per ingestion job to validate credentials and open the connection.
2. Calls `fetchBatch()` in a cursor loop until `hasMore` is `false`.
3. Calls `disconnect()` after the job finishes (success or error).

The connector never schedules itself — the platform controls when jobs run, either
on a cron schedule set at connector-instance configuration time, or on demand via
`client.connectors.trigger()` from the SDK.

## Directory structure

```
custom-connector/
  src/
    index.ts        — Connector implementation (the plugin entrypoint)
  manifest.json     — Plugin metadata validated by the platform at install time
  package.json      — Build tooling dependencies
  tsconfig.json     — TypeScript config (compiles to dist/)
```

## Prerequisites

- Node.js 18+
- A running OnePlatform instance (local or hosted)
- `@oneplatform/cli` installed globally (`npm install -g @oneplatform/cli`)

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Build the plugin
npm run build

# 3. Validate the manifest before packaging
npm run validate

# 4. Package and install into your platform instance
op plugin pack
op plugin install ./dist/example-shopify-products-1.0.0.oplugin \
  --platform https://your-instance.example.com \
  --api-key op_live_...
```

After installation, create a connector instance from the platform UI under
`Settings → Data Sources → + Add Data Source → Shopify Products (Example)`.

## Extending this example

- Add `subscribeToEvents()` to enable real-time webhooks (set `supportsRealtime: true` in `metadata()`).
- Add OAuth token refresh in `connect()` using `context.cache.lock()` to prevent concurrent refreshes.
- Throw `PluginRateLimitError` when the upstream API returns 429 — the Ingestion Service
  will back off and retry automatically.
