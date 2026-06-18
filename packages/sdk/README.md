# @oneplatform/sdk

TypeScript client for the OnePlatform API. Works in Node.js 18+ and modern browsers.

## Installation

```sh
pnpm add @oneplatform/sdk
```

## Quick Start

```ts
import { createClient } from '@oneplatform/sdk';

const client = createClient({
  baseUrl: 'https://api.example.com',
  auth: { apiKey: 'op_live_...' },
});

// Verify connectivity
const me = await client.ping();
console.log(me.email);

// List entities with async iteration
for await (const page of client.data.entity('Product').list()) {
  console.log(page.items);
}
```

## Authentication Modes

### API Key (server-side only)

API keys start with `op_live_` (production) or `op_test_` (testing). The SDK
rejects API key auth in browser environments at construction time — use PKCE
there instead.

```ts
const client = createClient({
  baseUrl: 'https://api.example.com',
  auth: { apiKey: 'op_live_abc123' },
});
```

### Access Token

Use when you already have a JWT from your auth layer. Provide an optional
`refreshToken` callback to enable automatic refresh on 401 responses.

```ts
const client = createClient({
  baseUrl: 'https://api.example.com',
  auth: {
    accessToken: currentToken,
    refreshToken: async () => {
      // Return a fresh token or null to propagate the AuthError
      return await myAuthService.refresh();
    },
  },
});
```

### PKCE (browser)

For browser applications. Tokens are stored in `sessionStorage` under the
`op_sdk` key prefix (configurable).

```ts
const client = createClient({
  baseUrl: 'https://api.example.com',
  auth: {
    browser: {
      // Format: "app:{appId}:{tenantId}"
      clientId: 'app:my-app:tenant-id',
      // Optional — defaults to window.location.origin + '/auth/callback'
      redirectUri: 'https://myapp.example.com/auth/callback',
      // Optional — defaults to ['openid', 'profile', 'data:read', 'data:write']
      scopes: ['openid', 'profile', 'data:read', 'data:write'],
    },
  },
});
```

## Resource Namespaces

Every namespace maps to a top-level REST resource group.

| Namespace | Description |
|---|---|
| `client.data` | Ontology-typed entity CRUD |
| `client.pipelines` | Pipeline management and triggers |
| `client.connectors` | Connector lifecycle management |
| `client.ontologies` | Ontology schema management |
| `client.events` | Real-time SSE subscriptions |
| `client.apps` | App deployment and management |
| `client.plugins` | Plugin lifecycle management |
| `client.apiKeys` | API key creation and revocation |
| `client.users` | User management (admin) |
| `client.logs` | Log and audit trail queries |

## Data Operations

Access entity resources in two equivalent styles:

```ts
// Explicit — works with any string type name
const products = client.data.entity('Product');

// Proxy shorthand — same result
const products = client.data.Product;
```

### CRUD

```ts
// Create
const product = await client.data.entity('Product').create({
  name: 'Widget',
  price: 29.99,
  status: 'active',
});

// Read single record
const product = await client.data.entity('Product').get('prod_123');

// Partial update (PATCH)
await client.data.entity('Product').update('prod_123', { price: 24.99 });

// Full replace (PUT)
await client.data.entity('Product').replace('prod_123', {
  name: 'Widget',
  price: 24.99,
  status: 'active',
});

// Delete
await client.data.entity('Product').delete('prod_123');
```

### Idempotent mutations

Pass an `idempotencyKey` to safely retry creates and updates without
duplicating data:

```ts
await client.data.entity('Order').create(
  { customerId: 'cust_1', total: 99 },
  { idempotencyKey: 'order-import-2024-001' },
);
```

### Bulk operations

```ts
const result = await client.data.entity('Product').bulk({
  mode: 'upsert',
  records: [
    { id: 'prod_1', name: 'Widget A', price: 10 },
    { id: 'prod_2', name: 'Widget B', price: 20 },
  ],
});

// result.items contains per-record success/failure
for (const item of result.items) {
  if (!item.success) console.error(item.id, item.error);
}
```

## Pagination

`list()` returns a `PaginatedIterable`. Consume it with `for await` — the SDK
fetches pages on demand and stops when the server signals no more data.

```ts
// Iterate all pages
for await (const page of client.data.entity('Product').list()) {
  // page.items: Product[]
  // page.nextCursor: string | null
  // page.total: number | null
  console.log(page.items);
}

// With options
for await (const page of client.data.entity('Product').list({
  limit: 100,        // page size
  sort: '-createdAt', // descending sort
  fields: ['id', 'name', 'price'], // field projection
})) {
  process(page.items);
}
```

## Filtering

Use the `filter` DSL for type-safe query building. The DSL is immutable — each
method returns a new builder instance, so you can branch and reuse safely.

```ts
import { filter } from '@oneplatform/sdk';

for await (const page of client.data.entity('Product').list({
  filter: filter('status').eq('active')
           .and('price').gt(100)
           .and('category').in(['electronics', 'appliances']),
})) {
  console.log(page.items);
}
```

Available operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `like`, `in`, `null`.

## Real-Time Events

Subscribe to platform events via Server-Sent Events. The SDK reconnects
automatically on transient network errors, resuming from `Last-Event-ID`.

```ts
import { type PlatformEvent } from '@oneplatform/sdk';

const subscription = client.events.subscribe(
  {
    events: ['pipeline.*', 'data.Product.created'],
    filter: {
      // Optional server-side filter to reduce traffic
      entityType: 'Product',
    },
  },
  (event: PlatformEvent) => {
    console.log(event.type, event.payload);
  },
);

// Monitor connection state
subscription.on('status', (status) => {
  console.log('SSE status:', status); // 'connecting' | 'connected' | 'reconnecting' | 'closed'
});

subscription.on('error', (err) => {
  console.error('SSE error:', err.message);
});

// Clean up when done
subscription.unsubscribe();
```

Event patterns support exact strings (`"pipeline.run.completed"`) and trailing
wildcards (`"pipeline.*"`).

## Error Handling

All errors extend `OnePlatformError`. Use `instanceof` checks to handle
specific error types.

```ts
import {
  OnePlatformError,
  AuthError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  RateLimitError,
  NetworkError,
  ConflictError,
  CursorExpiredError,
} from '@oneplatform/sdk';

try {
  await client.data.entity('Product').create(body);
} catch (err) {
  if (err instanceof ValidationError) {
    // Per-field failures
    for (const field of err.fields) {
      console.error(`${field.field}: ${field.message}`);
    }
    // Cross-field constraint violations
    for (const c of err.constraints) {
      console.error(c.message);
    }
  } else if (err instanceof NotFoundError) {
    console.error('Not found');
  } else if (err instanceof AuthError) {
    // 401 — redirect to login
    redirectToLogin();
  } else if (err instanceof ForbiddenError) {
    // 403 — insufficient permissions
    console.error('Permission denied');
  } else if (err instanceof RateLimitError) {
    // 429 — back off
    const retryAfter = err.retryAfter; // seconds hint, may be null
    console.error(`Rate limited. Retry after ${retryAfter}s`);
  } else if (err instanceof CursorExpiredError) {
    // 410 — cursor is older than 24 hours; restart from page 1
    restartPagination();
  } else if (err instanceof NetworkError) {
    // Transient connectivity failure — safe to retry
    console.error('Network error:', err.reason);
  } else if (err instanceof OnePlatformError) {
    console.error(err.code, err.message);
  }
}
```

### Error hierarchy

```
OnePlatformError
  ClientError (4xx, non-retryable)
    AuthError             401
    ForbiddenError        403
    NotFoundError         404
    ConflictError         409
    CursorExpiredError    410
    ValidationError       422  — err.fields[], err.constraints[]
    ConfigurationError    SDK misconfiguration, never reaches the network
    PaginationLimitError  collect() maxItems exceeded
  RateLimitError          429  — err.retryAfter: number | null
  ServerError             5xx
  NetworkError                 — err.reason: string
```

## Client Configuration

```ts
const client = createClient({
  baseUrl: 'https://api.example.com',
  auth: { apiKey: 'op_live_...' },

  // Retry policy (default: 3 retries, 500ms initial backoff, jitter on)
  retry: {
    maxRetries: 5,
    initialDelayMs: 1000,
    maxDelayMs: 60_000,
    retryableStatusCodes: [429, 500, 502, 503, 504],
    jitter: true,
  },

  // Per-request timeout (default: 30000ms)
  timeout: 60_000,

  // Custom headers merged onto every request
  headers: { 'X-Request-Source': 'backend-worker' },

  // SDK log level (default: 'warn')
  logLevel: 'info',

  // Custom fetch for testing or proxy scenarios
  fetch: myFetchImpl,
});

// Retrieve resolved config (auth tokens are redacted)
const config = client.getConfig();
// { baseUrl, timeout, logLevel, retry, authMode }
```

## TypeScript

The SDK is written in TypeScript and ships type declarations. All request and
response shapes are exported for use in your own types.

```ts
import type {
  OnePlatformClient,
  ClientOptions,
  Pipeline,
  PipelineRun,
  ConnectorInstance,
  OntologySchema,
  App,
  Plugin,
  ApiKey,
  User,
  LogEntry,
  AuditEntry,
  BulkOperation,
  BulkResult,
  PlatformEvent,
  Subscription,
  SubscriptionOptions,
  Page,
  PaginationOptions,
} from '@oneplatform/sdk';
```

## Cleanup

Call `destroy()` before your process exits or when you no longer need the
client. This terminates all active SSE subscriptions and aborts in-flight
requests.

```ts
process.on('SIGTERM', () => {
  client.destroy();
});
```

The client must not be reused after `destroy()`. Create a new instance if you
need to make further requests.
