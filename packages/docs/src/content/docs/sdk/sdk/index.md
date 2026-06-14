---
title: "@oneplatform/sdk"
description: Server-side TypeScript SDK for automating OnePlatform.
sidebar:
  order: 1
---

`@oneplatform/sdk` is the server-side TypeScript SDK for OnePlatform. Use it to
automate platform operations from Node.js scripts, CI pipelines, or backend services.

## Installation

```sh
npm install @oneplatform/sdk
```

## Quick start

```typescript
import { createClient } from "@oneplatform/sdk";

const client = createClient({ apiKey: process.env.OP_API_KEY });

// List entity types
const entities = await client.ontology.listEntities();

// Query records
const records = await client.data.query("customer", { limit: 50 });

// Trigger a sync
await client.connectors.trigger("production-db");
```

## API reference

Full TypeDoc-generated API reference is available after running:

```sh
pnpm turbo docs:generate && pnpm docs:merge
```

The generated reference will appear in this section automatically.

## Resources

- [Platform Admin Quickstart](/getting-started/platform-admin)
- [CLI Reference](/cli) — command-line equivalent of all SDK operations
- [API Reference](/api/) — raw HTTP API documentation
