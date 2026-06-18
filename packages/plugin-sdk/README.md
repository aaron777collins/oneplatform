# @oneplatform/plugin-sdk

Type definitions and error classes for building OnePlatform plugins.

The SDK is intentionally thin: it exports TypeScript interfaces and a small
error class hierarchy. It emits almost no runtime JavaScript — plugin code
imports types at compile time and the platform injects the error classes into
the execution sandbox at runtime.

## Installation

```sh
pnpm add @oneplatform/plugin-sdk
```

Build your plugin bundle with `--external:@oneplatform/plugin-sdk`. The
platform provides the SDK runtime; bundling it causes `instanceof` checks to
fail across the sandbox boundary.

## Plugin Types

| Type | Interface | Role |
|---|---|---|
| `connector` | `Connector` | Data source — fetches records from external systems |
| `transformer` | `Transformer` | Data transform — processes records in pipeline steps |
| `destination` | `Destination` | Data sink — writes records to external systems |
| `auth-provider` | `AuthProvider` | Identity — OAuth 2, SAML, OIDC, LDAP |
| `widget` | `Widget` | UI component — renders in platform dashboard slots |

## Creating a Connector

Implement the `Connector` interface to expose an external data source to the
platform's ingestion pipeline.

```ts
import type {
  Connector,
  ConnectorHandle,
  ConnectorMetadata,
  BatchResult,
  PluginContext,
} from '@oneplatform/plugin-sdk';
import {
  PluginAuthError,
  PluginConfigError,
  PluginRateLimitError,
  PluginDataError,
} from '@oneplatform/plugin-sdk';

export class ShopifyConnector implements Connector {
  metadata(): ConnectorMetadata {
    return {
      type: 'connector',
      id: 'shopify-connector',
      name: 'Shopify',
      description: 'Sync products, orders, and customers from Shopify.',
      version: '1.0.0',
      author: 'Acme Corp',
      category: 'ecommerce',
      configSchema: {
        type: 'object',
        required: ['shop'],
        properties: {
          shop: { type: 'string', description: 'Shopify store slug (e.g. my-store)' },
          apiVersion: { type: 'string', default: '2024-01' },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          price: { type: 'string' },
        },
      },
      supportsIncremental: true,
      supportsRealtime: false,
      rateLimit: { requestsPerMinute: 40 },
      tags: ['ecommerce', 'shopify'],
    };
  }

  async connect(
    config: Record<string, unknown>,
    context: PluginContext,
  ): Promise<ConnectorHandle> {
    const shop = config['shop'] as string | undefined;
    if (!shop) {
      throw new PluginConfigError('Missing required config field: shop', 'shop');
    }

    // Retrieve credentials stored by the platform admin
    const accessToken = await context.credentials.get('shopify_access_token');

    // Validate by making a lightweight API call
    const response = await context.fetch.fetch(
      `https://${shop}.myshopify.com/admin/api/2024-01/shop.json`,
      { headers: { 'X-Shopify-Access-Token': accessToken } },
    );

    if (response.status === 401) {
      throw new PluginAuthError('Shopify access token is invalid or expired.');
    }
    if (!response.ok) {
      throw new PluginAuthError(`Shopify connection check failed: HTTP ${response.status}`);
    }

    return {
      connectionId: `shopify:${shop}`,
      metadata: { shop, accessToken, apiVersion: config['apiVersion'] ?? '2024-01' },
    };
  }

  async fetchBatch(
    handle: ConnectorHandle,
    cursor: string | null,
    context: PluginContext,
  ): Promise<BatchResult> {
    const { shop, accessToken, apiVersion } = handle.metadata as {
      shop: string;
      accessToken: string;
      apiVersion: string;
    };

    const url = cursor
      ? `https://${shop}.myshopify.com/admin/api/${apiVersion}/products.json?limit=250&page_info=${cursor}`
      : `https://${shop}.myshopify.com/admin/api/${apiVersion}/products.json?limit=250`;

    const span = context.tracing.startSpan('shopify.fetchProducts');
    try {
      const response = await context.fetch.fetch(url, {
        headers: context.tracing.injectHeaders({
          'X-Shopify-Access-Token': accessToken,
        }),
      });

      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('Retry-After') ?? '5', 10);
        throw new PluginRateLimitError('Shopify rate limit reached.', retryAfter);
      }
      if (!response.ok) {
        throw new PluginDataError(`Unexpected Shopify response: HTTP ${response.status}`);
      }

      const body = await response.json() as { products: Record<string, unknown>[] };
      const linkHeader = response.headers.get('Link') ?? '';
      const nextMatch = linkHeader.match(/<[^>]+page_info=([^&>]+)[^>]*>;\s*rel="next"/);
      const nextCursor = nextMatch?.[1] ?? null;

      span.setAttribute('product.count', body.products.length);

      return {
        records: body.products,
        nextCursor,
        hasMore: nextCursor !== null,
        fetchedAt: new Date().toISOString(),
      };
    } finally {
      span.end();
    }
  }

  async disconnect(handle: ConnectorHandle, context: PluginContext): Promise<void> {
    // HTTP connections are stateless; nothing to release here.
    // Do NOT revoke the access token — it may be reused by the next sync run.
    context.logger.debug('Shopify connector disconnected.', {
      connectionId: handle.connectionId,
    });
  }
}
```

## Plugin Manifest

Every plugin ships a `plugin.manifest.json` at its package root. The Plugin
Service reads this at install time to register hooks and validate the
entrypoint.

```json
{
  "id": "shopify-connector",
  "version": "1.0.0",
  "type": "connector",
  "entrypoint": "dist/bundle.js",
  "requiredExternalUrls": [
    "https://*.myshopify.com/admin/**"
  ],
  "hooks": [],
  "configSchema": {
    "type": "object",
    "required": ["shop"],
    "properties": {
      "shop": { "type": "string" }
    }
  }
}
```

### Manifest fields

| Field | Type | Description |
|---|---|---|
| `id` | `string` | Unique identifier. Must match `metadata().id`. |
| `version` | `string` | SemVer. Must match `metadata().version`. |
| `type` | `string` | Plugin type: `connector`, `transformer`, `destination`, `auth-provider`, `widget` |
| `entrypoint` | `string` | Relative path to the compiled bundle (e.g. `dist/bundle.js`) |
| `requiredExternalUrls` | `string[]` | Glob patterns for permitted outbound URLs. Only HTTPS is allowed. |
| `hooks` | `HookDeclaration[]` | Hook registrations (empty for pure connectors) |
| `configSchema` | `JSONSchema` | Tenant admin configuration form schema |

## Hook System

Hooks intercept platform lifecycle events. Declare them in the manifest and
export named handler functions from your bundle.

```json
{
  "hooks": [
    {
      "stage": "before:ingestion.validate",
      "criticality": "critical",
      "priority": 50,
      "timeout": 10,
      "entrypoint": "onBeforeIngestionValidate"
    }
  ]
}
```

Implement the corresponding export:

```ts
import type { HookFn, IngestionValidateData } from '@oneplatform/plugin-sdk';

export const onBeforeIngestionValidate: HookFn<'before:ingestion.validate'> = async (
  payload,
  context,
) => {
  // payload.data is narrowed to IngestionValidateData — no cast needed
  const record = payload.data.record;

  if (!record['email']) {
    context.logger.warn('Record missing email field', { sourceId: payload.data.sourceId });
  }

  // Return modified data to pass downstream, or return the original to pass through
  return { data: payload.data };
};
```

### Hook stages

Hooks fire `before` or `after` each platform stage.

| Domain | Stages |
|---|---|
| Ingestion | `receive`, `validate`, `enrich`, `stage` |
| Ontology | `map`, `normalize` |
| Pipeline | `trigger`, `step`, `complete` |
| Execution | `setup`, `teardown` |
| Auth | `login`, `logout`, `token.issue` |
| App | `request`, `build` |

Criticality:
- `"critical"` — hook failure aborts the stage and surfaces an error to the caller. Use for validation invariants.
- `"advisory"` — hook failure is logged and the stage continues with the pre-hook payload. Use for enrichment or observability.

### Type-safe stage narrowing

Use `DiscriminatedHookPayload` when one handler covers multiple stages:

```ts
import type { DiscriminatedHookPayload } from '@oneplatform/plugin-sdk';

function handleAny(payload: DiscriminatedHookPayload): void {
  if (payload.stage === 'before:pipeline.trigger') {
    // payload.data is PipelineTriggerData here — TypeScript narrows automatically
    console.log(payload.data.pipelineId);
  } else if (payload.stage === 'after:pipeline.complete') {
    // payload.data is PipelineCompleteData
    console.log(payload.data.status);
  }
}
```

Use `HookDataFor<S>` to extract the data type for a specific stage without
re-typing the full payload:

```ts
import type { HookDataFor } from '@oneplatform/plugin-sdk';

type ReceiveData = HookDataFor<'before:ingestion.receive'>; // IngestionReceiveData
```

## Plugin Context

The platform injects a `PluginContext` into every plugin method. Never
construct it directly.

```ts
interface PluginContext {
  credentials: CredentialAccessor;  // Read encrypted credentials by name
  fetch: FetchProxy;                // Proxied HTTP — only allowlisted URLs
  cache: CacheAccessor;             // Namespaced key-value cache with TTL and locking
  logger: PluginLogger;             // Structured logging (debug/info/warn/error)
  tenant: TenantContext;            // Tenant ID, name, config, and instance ID
  ontology: OntologyAccessor;       // Read-only access to the tenant's entity schema
  tracing: TracingContext;          // Distributed tracing (span creation, header injection)
}
```

### Cache with distributed lock

```ts
// Acquire a lock before performing a singleton operation (e.g., token refresh)
const lock = await context.cache.lock('token-refresh', 30);
if (lock) {
  try {
    const token = await refreshExternalToken();
    await context.cache.set('access_token', token, 3600);
  } finally {
    await lock.release();
  }
}
```

## Creating a Transformer

Transformers run inside pipeline steps. They receive records and return
transformed records or `null` to drop them.

```ts
import type { Transformer, TransformerContext, TransformerMetadata } from '@oneplatform/plugin-sdk';
import type { DataRecord } from '@oneplatform/plugin-sdk';
import { PluginDataError } from '@oneplatform/plugin-sdk';

export class CurrencyNormalizer implements Transformer {
  metadata(): TransformerMetadata {
    return {
      type: 'transformer',
      id: 'currency-normalizer',
      name: 'Currency Normalizer',
      description: 'Converts price fields from string to number and normalises currency codes.',
      version: '1.0.0',
      author: 'Acme Corp',
      configSchema: {
        type: 'object',
        properties: {
          field: { type: 'string', default: 'price' },
        },
      },
      idempotent: true,
    };
  }

  async transform(record: DataRecord, context: TransformerContext): Promise<DataRecord | null> {
    const field = (context.tenant.config['field'] as string | undefined) ?? 'price';
    const raw = record[field];

    if (raw === undefined) {
      // Pass the record through unchanged; the field may be optional
      return record;
    }

    const price = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
    if (isNaN(price)) {
      throw new PluginDataError(
        `Cannot parse price field "${field}": invalid value`,
        { field, value: raw },
      );
    }

    // Return a new object — do not mutate the input record
    return { ...record, [field]: price };
  }
}
```

## Error Classes

Throw typed errors so the platform can route retries and dead-letter queue
entries correctly.

| Class | `isRetryable` | When to throw |
|---|---|---|
| `PluginAuthError` | `false` | External service returned 401/403 |
| `PluginRateLimitError` | `true` | External service returned 429; pass `retryAfterSeconds` if available |
| `PluginTimeoutError` | `true` | Network call or sandbox execution timed out |
| `PluginDataError` | `false` | Malformed or unprocessable record; include a sample |
| `PluginConfigError` | `false` | Required config field missing or invalid; throw from `connect()` only |

```ts
import {
  PluginAuthError,
  PluginRateLimitError,
  PluginTimeoutError,
  PluginDataError,
  PluginConfigError,
} from '@oneplatform/plugin-sdk';

// Auth failure — no retry
throw new PluginAuthError('API key expired.');

// Rate limit — retry after hint
throw new PluginRateLimitError('Rate limited by external API.', 30 /* seconds */);

// Bad data — no retry, DLQ with sample
throw new PluginDataError('Unexpected response shape.', rawBody);

// Config error — only in connect()
throw new PluginConfigError('Missing required config field.', 'apiKey');
```

## Testing

Use mock factories to test plugin logic without a live platform:

```ts
import { describe, it, expect, vi } from 'vitest';
import { ShopifyConnector } from './shopify-connector.js';
import type { PluginContext } from '@oneplatform/plugin-sdk';

function makeContext(overrides: Partial<PluginContext> = {}): PluginContext {
  return {
    credentials: {
      get: vi.fn().mockResolvedValue('test-token'),
      list: vi.fn().mockResolvedValue(['shopify_access_token']),
    },
    fetch: {
      fetch: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ products: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    },
    cache: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      lock: vi.fn().mockResolvedValue(null),
    },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    tenant: {
      tenantId: 'tenant-1',
      tenantName: 'Test Tenant',
      config: { shop: 'test-store' },
      instanceId: 'instance-1',
    },
    ontology: {
      getSchema: vi.fn(),
      getEntitySchema: vi.fn().mockResolvedValue(null),
    },
    tracing: {
      injectHeaders: (h) => h,
      startSpan: () => ({ setAttribute: vi.fn(), end: vi.fn() }),
    },
    ...overrides,
  } as unknown as PluginContext;
}

describe('ShopifyConnector', () => {
  it('throws PluginConfigError when shop is missing', async () => {
    const connector = new ShopifyConnector();
    const ctx = makeContext();
    await expect(connector.connect({}, ctx)).rejects.toThrow('Missing required config field: shop');
  });

  it('returns empty batch when no products', async () => {
    const connector = new ShopifyConnector();
    const ctx = makeContext();
    const handle = await connector.connect({ shop: 'test-store' }, ctx);
    const result = await connector.fetchBatch(handle, null, ctx);
    expect(result.records).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });
});
```

## Publishing and Installing Plugins

1. Build your plugin bundle:
   ```sh
   esbuild src/index.ts \
     --bundle \
     --platform=node \
     --format=esm \
     --external:@oneplatform/plugin-sdk \
     --outfile=dist/bundle.js
   ```

2. Package the plugin:
   ```sh
   # Include plugin.manifest.json and dist/bundle.js
   tar -czf my-plugin-1.0.0.tgz plugin.manifest.json dist/
   ```

3. Install via the CLI:
   ```sh
   op plugin install --file my-plugin-1.0.0.tgz
   ```

4. Or install from the marketplace:
   ```sh
   op plugin install shopify-connector@1.0.0
   ```
