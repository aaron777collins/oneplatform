[**@oneplatform/core**](../README.md)

***

[@oneplatform/core](../README.md) / CreateAppConfig

# Interface: CreateAppConfig

Defined in: [packages/core/src/app.ts:76](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/app.ts#L76)

Configuration for [createApp](../functions/createApp.md).

Passed once at startup; all fields are immutable for the lifetime of the app.

## Properties

### allowedOrigins

> **allowedOrigins**: `string`[]

Defined in: [packages/core/src/app.ts:94](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/app.ts#L94)

Allowed CORS origins from `OP_ALLOWED_ORIGINS`; requests from other origins receive 403.

***

### jwtSecret

> **jwtSecret**: `string`

Defined in: [packages/core/src/app.ts:84](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/app.ts#L84)

HS256 secret used to verify and sign JWTs (`OP_JWT_SECRET`).

***

### maxBodySize?

> `optional` **maxBodySize?**: `number`

Defined in: [packages/core/src/app.ts:113](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/app.ts#L113)

Maximum allowed request body size in bytes. Defaults to 10 MiB.

Requests exceeding this limit receive `413 Payload Too Large` before any
business logic runs, preventing memory exhaustion from oversized uploads.

***

### publicRoutes

> **publicRoutes**: `string`[]

Defined in: [packages/core/src/app.ts:100](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/app.ts#L100)

Routes that bypass JWT/API-key authentication.
Typically `['/healthz', '/readyz']` plus any public OAuth callback paths.

***

### redis

> **redis**: `Redis`

Defined in: [packages/core/src/app.ts:86](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/app.ts#L86)

Redis client used by the auth middleware for token blocklist lookups.

***

### serviceName

> **serviceName**: `string`

Defined in: [packages/core/src/app.ts:78](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/app.ts#L78)

Human-readable service name used in logs and telemetry (e.g. `'ontology-service'`).

***

### servicePublicKeys

> **servicePublicKeys**: `Record`\<`string`, `string`\>

Defined in: [packages/core/src/app.ts:105](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/app.ts#L105)

Ed25519 public keys keyed by service name, loaded from `/data/service-keys/` at startup.

***

### targetService

> **targetService**: `string`

Defined in: [packages/core/src/app.ts:103](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/app.ts#L103)

The name of *this* service used to verify incoming service-to-service tokens.

***

### validateApiKey

> **validateApiKey**: (`key`) => `Promise`\<[`UserContext`](UserContext.md) \| `null`\>

Defined in: [packages/core/src/app.ts:91](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/app.ts#L91)

Callback that resolves an API key to a `UserContext`, or `null` if the key
is invalid. Called on every request that presents an `X-API-Key` header.

#### Parameters

##### key

`string`

#### Returns

`Promise`\<[`UserContext`](UserContext.md) \| `null`\>

***

### version

> **version**: `string`

Defined in: [packages/core/src/app.ts:80](https://github.com/aaron777collins/oneplatform/blob/e5bb8f585c10107015e961e4e99a8fbe094a70d3/packages/core/src/app.ts#L80)

Semver version string included in log output for traceability.
